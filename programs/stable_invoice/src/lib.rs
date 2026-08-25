//! StableInvoice — escrowed USDC invoicing for freelancers.
//!
//! Devnet-only MVP skeleton. Instruction contexts are real; bodies are stubs.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"); // TODO: replace with program keypair after first `anchor keys sync`

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
        let invoice = &mut ctx.accounts.invoice;
        invoice.index = index;
        invoice.freelancer = ctx.accounts.freelancer.key();
        invoice.usdc_mint = ctx.accounts.usdc_mint.key();
        invoice.amount_usdc = amount_usdc;
        invoice.milestone_count = milestone_count;
        invoice.milestones_accepted = 0;
        invoice.status = InvoiceStatus::Draft;
        invoice.bump = ctx.bumps.invoice;
        Ok(())
    }

    /// Client funds the whole invoice into the escrow vault.
    // TODO: token::transfer client_usdc -> vault (total = amount * milestones), status = Funded
    pub fn fund_escrow(_ctx: Context<FundEscrow>) -> Result<()> {
        err!(StableInvoiceError::NotImplemented)
    }

    /// Client accepts the next milestone.
    // TODO: require status == Funded, milestones_accepted < milestone_count, increment
    pub fn accept_milestone(_ctx: Context<AcceptMilestone>) -> Result<()> {
        err!(StableInvoiceError::NotImplemented)
    }

    /// Releases payment for accepted milestones to the freelancer and writes the
    /// settlement record (status = Settled) on-chain.
    // TODO: token::transfer vault -> freelancer_usdc for released milestones, status = Settled
    pub fn settle(_ctx: Context<Settle>) -> Result<()> {
        err!(StableInvoiceError::NotImplemented)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Invoice {
    pub index: u64,
    pub freelancer: Pubkey,
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
    )]
    pub invoice: Account<'info, Invoice>,
    /// Escrow vault: invoice-owned USDC ATA.
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = invoice,
    )]
    pub vault: Account<'info, TokenAccount>,
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
    pub client: Signer<'info>,
    #[account(
        mut,
        seeds = [b"invoice", invoice.freelancer.as_ref(), &invoice.index.to_le_bytes()],
        bump = invoice.bump,
        constraint = invoice.status == InvoiceStatus::Funded @ StableInvoiceError::NotFunded,
    )]
    pub invoice: Account<'info, Invoice>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub freelancer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"invoice", invoice.freelancer.as_ref(), &invoice.index.to_le_bytes()],
        bump = invoice.bump,
        constraint = invoice.freelancer == freelancer.key() @ StableInvoiceError::Unauthorized,
        constraint = invoice.status == InvoiceStatus::Funded @ StableInvoiceError::NotFunded,
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
    #[msg("Instruction not implemented yet — MVP skeleton")]
    NotImplemented,
    #[msg("Invoice is not in Funded state")]
    NotFunded,
    #[msg("Only the invoice's freelancer can settle")]
    Unauthorized,
}
