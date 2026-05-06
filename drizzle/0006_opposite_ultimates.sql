ALTER TABLE `dependencies` MODIFY COLUMN `targetSymbolId` int;--> statement-breakpoint
ALTER TABLE `files` MODIFY COLUMN `content` mediumtext;--> statement-breakpoint
ALTER TABLE `dependencies` ADD `targetExternalName` varchar(255);--> statement-breakpoint
ALTER TABLE `dependencies` ADD `targetKind` enum('internal','external','unresolved') DEFAULT 'internal' NOT NULL;