ALTER TABLE `dependencies` DROP FOREIGN KEY `dependencies_targetSymbolId_symbols_id_fk`;--> statement-breakpoint
ALTER TABLE `dependencies` MODIFY COLUMN `targetSymbolId` int;--> statement-breakpoint
ALTER TABLE `dependencies` ADD CONSTRAINT `dependencies_targetSymbolId_symbols_id_fk` FOREIGN KEY (`targetSymbolId`) REFERENCES `symbols`(`id`) ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE `files` MODIFY COLUMN `content` mediumtext;--> statement-breakpoint
ALTER TABLE `dependencies` ADD `targetExternalName` varchar(255);--> statement-breakpoint
ALTER TABLE `dependencies` ADD `targetKind` enum('internal','external','unresolved') DEFAULT 'internal' NOT NULL;
