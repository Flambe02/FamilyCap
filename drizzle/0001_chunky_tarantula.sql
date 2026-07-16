ALTER TABLE `investment_entries` ADD `entered_by` text DEFAULT 'Administrateur' NOT NULL;--> statement-breakpoint
ALTER TABLE `investment_entries` ADD `entered_by_role` text DEFAULT 'Administrateur' NOT NULL;--> statement-breakpoint
ALTER TABLE `investment_entries` ADD `status` text DEFAULT 'Confirmée' NOT NULL;--> statement-breakpoint
ALTER TABLE `investment_entries` ADD `reference` text;