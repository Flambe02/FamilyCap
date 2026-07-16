PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_gift_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`member_id` integer,
	`member_name` text NOT NULL,
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
	`note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_gift_records`("id", "member_id", "member_name", "occasion", "gift_date", "purchase_date", "amount_eur", "btc_amount", "custody", "transfer_date", "ledger_amount", "public_address", "txid", "blockchain_status", "confirmations", "note", "created_at") SELECT "id", "member_id", "member_name", "occasion", "gift_date", "purchase_date", "amount_eur", "btc_amount", "custody", "transfer_date", "ledger_amount", "public_address", "txid", "blockchain_status", "confirmations", "note", "created_at" FROM `gift_records`;--> statement-breakpoint
DROP TABLE `gift_records`;--> statement-breakpoint
ALTER TABLE `__new_gift_records` RENAME TO `gift_records`;--> statement-breakpoint
PRAGMA foreign_keys=ON;