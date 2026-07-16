CREATE TABLE `gift_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`member_id` integer NOT NULL,
	`occasion` text NOT NULL,
	`gift_date` text NOT NULL,
	`purchase_date` text NOT NULL,
	`amount_eur` real NOT NULL,
	`btc_amount` real NOT NULL,
	`custody` text NOT NULL,
	`transfer_date` text,
	`ledger_amount` real,
	`public_address` text,
	`txid` text,
	`blockchain_status` text DEFAULT 'not_checked' NOT NULL,
	`confirmations` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transfer_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`member_name` text NOT NULL,
	`transaction_id` text NOT NULL,
	`btc_amount` real,
	`requested_at` text NOT NULL,
	`status` text DEFAULT 'Nouvelle' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
