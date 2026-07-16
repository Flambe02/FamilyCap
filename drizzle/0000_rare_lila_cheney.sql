CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`member_id` integer NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`institution` text,
	`public_identifier` text,
	`network` text,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `family_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`role` text DEFAULT 'member' NOT NULL,
	`birthday_day` integer,
	`birthday_month` integer,
	`access_status` text DEFAULT 'invited' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `investment_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`member_id` integer NOT NULL,
	`account_type` text NOT NULL,
	`asset_name` text NOT NULL,
	`asset_code` text,
	`operation_date` text NOT NULL,
	`amount_eur` real NOT NULL,
	`quantity` real,
	`fees_eur` real DEFAULT 0 NOT NULL,
	`note` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monthly_missions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`title` text NOT NULL,
	`lesson` text NOT NULL,
	`suggested_amount_eur` real NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
