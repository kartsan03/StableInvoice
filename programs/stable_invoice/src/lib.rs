//! StableInvoice — escrowed USDC invoicing for freelancers.
//!
//! M1: initialize_invoice, fund_escrow, accept_milestone
//! (CPI transfer_checked, status transitions, events).
//! M2: settle drains the vault into the freelancer ATA (PDA-signed
//! transfer_checked) and writes a settlement PDA. Not deployed.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("36yRHdUHk63ZWUDpKiadoWm5UKxdD4j43KhKyHKFm9mU");

#[program]
pub mod stable_invoice {
    use super::*;

    /// Freelancer opens an invoice: `milestone_count` milestones of `amount_usdc` each.
    pub fn initialize_invoice(
        ctx: Context<InitializeInvoice>,
        amount_usdc: u64,
        milestone_count: u8,
        index: u64,
    ) -> Result<()> {
        require!(amount_usdc > 0, StableInvoiceError::InvalidInvoiceParams);
        require!(milestone_count > 0, StableInvoiceError::InvalidInvoiceParams);

        let invoice = &mut ctx.accounts.invoice;
        invoice.index = index;
        invoice.freelancer = ctx.accounts.freelancer.key();
        invoice.usdc_mint = ctx.accounts.usdc_mint.key();
        invoice.amount_usdc = amount_usdc;
        invoice.milestone_count = milestone_count;
        invoice.milestones_accepted = 0;
        invoice.client = Pubkey::default(); // set at fund time
        invoice.status = InvoiceStatus::Draft;
        invoice.bump = ctx.bumps.invoice;

        emit!(InvoiceCreated {
            invoice: invoice.key(),
            freelancer: invoice.freelancer,
            amount_usdc,
            milestone_count,
            index,
        });
        Ok(())
    }

    /// Client funds the whole invoice into the escrow vault.
    ///
    /// MVP limitation (documented): whoever funds becomes the invoice's client —
    /// the payer is not fixed at creation time.
    pub fn fund_escrow(ctx: Context<FundEscrow>) -> Result<()> {
        let invoice_acc = &ctx.accounts.invoice;
        let total = invoice_acc
            .amount_usdc
            .checked_mul(invoice_acc.milestone_count as u64)
            .ok_or(StableInvoiceError::Overflow)?;

        // Create the escrow vault (invoice-owned ATA) if it doesn't exist yet.
        if ctx.accounts.vault.data_is_empty() {
            associated_token::create_idempotent(CpiContext::new(
                ctx.accounts.associated_token_program.key(),
                associated_token::Create {
                    payer: ctx.accounts.client.to_account_info(),
                    associated_token: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.invoice.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ))?;
        }

        // CPI: client_usdc -> vault (vault ATA owned by the invoice PDA),
        // signed by the client. transfer_checked validates mint + decimals.
        let decimals = ctx.accounts.usdc_mint.decimals;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.client_usdc.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    authority: ctx.accounts.client.to_account_info(),
                },
            ),
            total,
            decimals,
        )?;

        let invoice = &mut ctx.accounts.invoice;
        invoice.status = InvoiceStatus::Funded;
        invoice.client = ctx.accounts.client.key();

        emit!(InvoiceFunded {
            invoice: invoice.key(),
            client: invoice.client,
            total_amount: total,
        });
        Ok(())
    }

    /// Client accepts the next milestone. No token movement here —
    /// settlement release happens in settle().
    pub fn accept_milestone(ctx: Context<AcceptMilestone>) -> Result<()> {
        let invoice = &mut ctx.accounts.invoice;
        invoice.milestones_accepted = invoice
            .milestones_accepted
            .checked_add(1)
            .ok_or(StableInvoiceError::Overflow)?;

        emit!(MilestoneAccepted {
            invoice: invoice.key(),
            client: invoice.client,
            milestones_accepted: invoice.milestones_accepted,
            milestone_count: invoice.milestone_count,
        });
        Ok(())
    }

    /// Drain the vault (`amount_usdc × milestone_count`) to the freelancer ATA
    /// and persist a settlement PDA. Signer must be the invoice client or freelancer.
    ///
    /// If the freelancer ATA is missing it is created idempotently (same pattern
    /// as the vault in fund_escrow); the settler pays the ATA rent.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let invoice_key = ctx.accounts.invoice.key();
        let freelancer_key = ctx.accounts.invoice.freelancer;
        let client_key = ctx.accounts.invoice.client;
        let milestone_count = ctx.accounts.invoice.milestone_count;
        let bump = ctx.accounts.invoice.bump;
        let index = ctx.accounts.invoice.index.to_le_bytes();
        let bump_seed = [bump];

        let total = ctx
            .accounts
            .invoice
            .amount_usdc
            .checked_mul(milestone_count as u64)
            .ok_or(StableInvoiceError::Overflow)?;
        require!(
            ctx.accounts.vault.amount == total,
            StableInvoiceError::InvalidVault
        );

        if ctx.accounts.freelancer_usdc.data_is_empty() {
            associated_token::create_idempotent(CpiContext::new(
                ctx.accounts.associated_token_program.key(),
                associated_token::Create {
                    payer: ctx.accounts.authority.to_account_info(),
                    associated_token: ctx.accounts.freelancer_usdc.to_account_info(),
                    authority: ctx.accounts.freelancer.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ))?;
        }

        let signer_seeds: &[&[u8]] = &[
            b"invoice",
            freelancer_key.as_ref(),
            &index,
            &bump_seed,
        ];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.freelancer_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    authority: ctx.accounts.invoice.to_account_info(),
                },
                &[signer_seeds],
            ),
            total,
            ctx.accounts.usdc_mint.decimals,
        )?;

        let timestamp = Clock::get()?.unix_timestamp;
        let settlement_key = ctx.accounts.settlement.key();
        let settlement_bump = ctx.bumps.settlement;

        let settlement = &mut ctx.accounts.settlement;
        settlement.invoice = invoice_key;
        settlement.amount = total;
        settlement.timestamp = timestamp;
        settlement.milestone_count = milestone_count;
        settlement.bump = settlement_bump;

        ctx.accounts.invoice.status = InvoiceStatus::Settled;

        emit!(InvoiceSettled {
            invoice: invoice_key,
            settlement: settlement_key,
            freelancer: freelancer_key,
            client: client_key,
            amount: total,
            milestone_count,
            timestamp,
        });
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Invoice {
    pub index: u64,
    pub freelancer: Pubkey,
    /// Set when the invoice is funded; only this key may accept milestones.
    pub client: Pubkey,
    pub usdc_mint: Pubkey,
    pub amount_usdc: u64,
    pub milestone_count: u8,
    pub milestones_accepted: u8,
    pub status: InvoiceStatus,
    pub bump: u8,
}

/// Permanent on-chain settlement record. Seeds: `[b"settlement", invoice.key()]`.
#[account]
#[derive(InitSpace)]
pub struct Settlement {
    pub invoice: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    pub milestone_count: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum InvoiceStatus {
    Draft,
    Funded,
    Settled,
}

// ---------- Events ----------

#[event]
pub struct InvoiceCreated {
    pub invoice: Pubkey,
    pub freelancer: Pubkey,
    pub amount_usdc: u64,
    pub milestone_count: u8,
    pub index: u64,
}

#[event]
pub struct InvoiceFunded {
    pub invoice: Pubkey,
    pub client: Pubkey,
    pub total_amount: u64,
}

#[event]
pub struct MilestoneAccepted {
    pub invoice: Pubkey,
    pub client: Pubkey,
    pub milestones_accepted: u8,
    pub milestone_count: u8,
}

#[event]
pub struct InvoiceSettled {
    pub invoice: Pubkey,
    pub settlement: Pubkey,
    pub freelancer: Pubkey,
    pub client: Pubkey,
    pub amount: u64,
    pub milestone_count: u8,
    pub timestamp: i64,
}

// ---------- Contexts ----------

#[derive(Accounts)]
#[instruction(amount_usdc: u64, milestone_count: u8, index: u64)]
pub struct InitializeInvoice<'info> {
    #[account(mut)]
    pub freelancer: Signer<'info>,
    #[account(
        init,
        payer = freelancer,
        space = 8 + Invoice::INIT_SPACE,
        seeds = [b"invoice", freelancer.key().as_ref(), &index.to_le_bytes()],
        bump,
    )]
    pub invoice: Account<'info, Invoice>,
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        mut,
        seeds = [b"invoice", invoice.freelancer.as_ref(), &invoice.index.to_le_bytes()],
        bump = invoice.bump,
        constraint = invoice.status == InvoiceStatus::Draft
            @ StableInvoiceError::AlreadyFunded,
    )]
    pub invoice: Account<'info, Invoice>,
    /// Escrow vault: invoice-owned USDC ATA (off-curve owner).
    /// CHECK: address validated below against the invoice PDA's ATA derivation.
    #[account(
        mut,
        constraint = vault.key()
            == associated_token::get_associated_token_address(&invoice.key(), &usdc_mint.key())
            @ StableInvoiceError::InvalidVault,
    )]
    pub vault: UncheckedAccount<'info>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = client,
    )]
    pub client_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptMilestone<'info> {
    #[account(
        mut,
        seeds = [b"invoice", invoice.freelancer.as_ref(), &invoice.index.to_le_bytes()],
        bump = invoice.bump,
        constraint = invoice.status == InvoiceStatus::Funded
            @ StableInvoiceError::NotFunded,
        constraint = invoice.client == client.key()
            @ StableInvoiceError::Unauthorized,
        constraint = invoice.milestones_accepted < invoice.milestone_count
            @ StableInvoiceError::AllMilestonesAccepted,
    )]
    pub invoice: Account<'info, Invoice>,
    pub client: Signer<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    /// Invoice client or freelancer. Pays rent for the settlement PDA
    /// (and the freelancer ATA if it has to be created).
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"invoice", invoice.freelancer.as_ref(), &invoice.index.to_le_bytes()],
        bump = invoice.bump,
        constraint = invoice.status == InvoiceStatus::Funded
            @ StableInvoiceError::NotFunded,
        constraint = authority.key() == invoice.freelancer || authority.key() == invoice.client
            @ StableInvoiceError::Unauthorized,
        constraint = invoice.milestones_accepted == invoice.milestone_count
            @ StableInvoiceError::MilestonesIncomplete,
    )]
    pub invoice: Account<'info, Invoice>,
    /// CHECK: destination ATA owner; must be the invoice freelancer.
    #[account(address = invoice.freelancer)]
    pub freelancer: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Settlement::INIT_SPACE,
        seeds = [b"settlement", invoice.key().as_ref()],
        bump,
    )]
    pub settlement: Account<'info, Settlement>,
    #[account(address = invoice.usdc_mint @ StableInvoiceError::InvalidVault)]
    pub usdc_mint: Account<'info, Mint>,
    /// Escrow vault: invoice-owned USDC ATA (off-curve owner).
    #[account(
        mut,
        constraint = vault.key()
            == associated_token::get_associated_token_address(&invoice.key(), &usdc_mint.key())
            @ StableInvoiceError::InvalidVault,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: must be the freelancer's ATA for this mint (created idempotently if empty).
    #[account(
        mut,
        constraint = freelancer_usdc.key()
            == associated_token::get_associated_token_address(&invoice.freelancer, &usdc_mint.key())
            @ StableInvoiceError::InvalidFreelancerAta,
    )]
    pub freelancer_usdc: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum StableInvoiceError {
    #[msg("Invoice is not in Funded state")]
    NotFunded,
    #[msg("Only the invoice's client/freelancer can call this")]
    Unauthorized,
    #[msg("Invoice has already been funded")]
    AlreadyFunded,
    #[msg("Every milestone has already been accepted")]
    AllMilestonesAccepted,
    #[msg("Invalid invoice parameters (amount/count must be > 0)")]
    InvalidInvoiceParams,
    #[msg("Vault must be the invoice's associated token account")]
    InvalidVault,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Cannot settle until every milestone is accepted")]
    MilestonesIncomplete,
    #[msg("Freelancer USDC account must be the freelancer's ATA for this mint")]
    InvalidFreelancerAta,
}
