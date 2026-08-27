//! StableInvoice — escrowed USDC invoicing for freelancers.
//!
//! M1 scope: initialize_invoice, fund_escrow, accept_milestone implemented
//! (CPI transfer_checked, status transitions, events).
//! settle() remains an M2 stub: release logic + settlement record land there.

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
    /// the payer is not fixed at creation time. Revisit in M2+ if front-running
    /// matters for devnet UX.
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
    /// settlement release happens in settle() (M2).
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

    /// Releases payment for accepted milestones to the freelancer and writes the
    /// settlement record (status = Settled) on-chain.
    // TODO(M2): token::transfer_checked vault -> freelancer_usdc (PDA-signed CPI),
    // require status == Funded && milestones_accepted > 0, status = Settled.
    pub fn settle(_ctx: Context<Settle>) -> Result<()> {
        err!(StableInvoiceError::NotImplemented)
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
    pub vault:UncheckedAccount<'info>,
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
    #[account(mut)]
    pub freelancer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"invoice", invoice.freelancer.as_ref(), &invoice.index.to_le_bytes()],
        bump = invoice.bump,
        constraint = invoice.freelancer == freelancer.key()
            @ StableInvoiceError::Unauthorized,
        constraint = invoice.status == InvoiceStatus::Funded
            @ StableInvoiceError::NotFunded,
    )]
    pub invoice: Account<'info, Invoice>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = invoice)]
    pub vault: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, associated_token::mint = usdc_mint, associated_token::authority = freelancer)]
    pub freelancer_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum StableInvoiceError {
    #[msg("Instruction not implemented yet — lands in M2")]
    NotImplemented,
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
}
