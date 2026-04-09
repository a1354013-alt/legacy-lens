UPDATE `projects` SET `status` = 'draft' WHERE `status` = 'pending';--> statement-breakpoint
ALTER TABLE `projects` MODIFY COLUMN `status` enum('draft','importing','ready','analyzing','completed','failed') NOT NULL DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE `projects` MODIFY COLUMN `analysisProgress` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `analysisResults` ADD `status` enum('pending','processing','completed','partial','failed') DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `analysisResults` ADD `summaryJson` json;--> statement-breakpoint
ALTER TABLE `analysisResults` ADD `warningsJson` json DEFAULT ('[]') NOT NULL;--> statement-breakpoint
ALTER TABLE `analysisResults` ADD `errorMessage` text;--> statement-breakpoint
ALTER TABLE `files` ADD `status` enum('stored','failed') DEFAULT 'stored' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `importProgress` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `lastErrorCode` varchar(64);
