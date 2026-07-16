import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const familyMembers = sqliteTable("family_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email"),
  role: text("role").notNull().default("member"),
  birthdayDay: integer("birthday_day"),
  birthdayMonth: integer("birthday_month"),
  accessStatus: text("access_status").notNull().default("invited"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  memberId: integer("member_id").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  institution: text("institution"),
  publicIdentifier: text("public_identifier"),
  network: text("network"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const investmentEntries = sqliteTable("investment_entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  memberId: integer("member_id").notNull(),
  accountType: text("account_type").notNull(),
  assetName: text("asset_name").notNull(),
  assetCode: text("asset_code"),
  operationDate: text("operation_date").notNull(),
  amountEur: real("amount_eur").notNull(),
  quantity: real("quantity"),
  feesEur: real("fees_eur").notNull().default(0),
  note: text("note"),
  source: text("source").notNull().default("manual"),
  enteredBy: text("entered_by").notNull().default("Administrateur"),
  enteredByRole: text("entered_by_role").notNull().default("Administrateur"),
  status: text("status").notNull().default("Confirmée"),
  reference: text("reference"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const monthlyMissions = sqliteTable("monthly_missions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  month: text("month").notNull(),
  title: text("title").notNull(),
  lesson: text("lesson").notNull(),
  suggestedAmountEur: real("suggested_amount_eur").notNull(),
  status: text("status").notNull().default("draft"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const giftRecords = sqliteTable("gift_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  memberId: integer("member_id"),
  memberName: text("member_name").notNull(),
  occasion: text("occasion").notNull(),
  giftDate: text("gift_date").notNull(),
  purchaseDate: text("purchase_date").notNull(),
  amountEur: real("amount_eur").notNull(),
  btcAmount: real("btc_amount").notNull(),
  custody: text("custody").notNull(),
  transferDate: text("transfer_date"),
  ledgerAmount: real("ledger_amount"),
  publicAddress: text("public_address"),
  txid: text("txid"),
  blockchainStatus: text("blockchain_status").notNull().default("not_checked"),
  confirmations: integer("confirmations").notNull().default(0),
  note: text("note"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const transferRequests = sqliteTable("transfer_requests", {
  id: text("id").primaryKey(),
  memberName: text("member_name").notNull(),
  transactionId: text("transaction_id").notNull(),
  btcAmount: real("btc_amount"),
  requestedAt: text("requested_at").notNull(),
  status: text("status").notNull().default("Nouvelle"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});