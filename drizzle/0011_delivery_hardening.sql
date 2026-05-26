ALTER TABLE `projectJobs` ADD COLUMN `lockedBy` varchar(128);
--> statement-breakpoint
ALTER TABLE `projectJobs` ADD COLUMN `leaseUntil` timestamp;
--> statement-breakpoint
ALTER TABLE `projectJobs` ADD COLUMN `heartbeatAt` timestamp;
--> statement-breakpoint
ALTER TABLE `projectJobs` ADD COLUMN `attemptCount` int NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `projectJobs` ADD COLUMN `maxAttempts` int NOT NULL DEFAULT 3;
--> statement-breakpoint
CREATE INDEX `files_projectId_filePath_idx` ON `files` (`projectId`, `filePath`);
--> statement-breakpoint
CREATE INDEX `symbols_projectId_name_idx` ON `symbols` (`projectId`, `name`);
--> statement-breakpoint
CREATE INDEX `symbols_projectId_fileId_idx` ON `symbols` (`projectId`, `fileId`);
--> statement-breakpoint
CREATE INDEX `fields_projectId_tableName_fieldName_idx` ON `fields` (`projectId`, `tableName`, `fieldName`);
--> statement-breakpoint
CREATE INDEX `dependencies_projectId_sourceSymbolId_idx` ON `dependencies` (`projectId`, `sourceSymbolId`);
--> statement-breakpoint
CREATE INDEX `dependencies_projectId_targetSymbolId_idx` ON `dependencies` (`projectId`, `targetSymbolId`);
--> statement-breakpoint
CREATE INDEX `fieldDependencies_projectId_fieldId_idx` ON `fieldDependencies` (`projectId`, `fieldId`);
--> statement-breakpoint
CREATE INDEX `risks_projectId_severity_idx` ON `risks` (`projectId`, `severity`);
--> statement-breakpoint
CREATE INDEX `rules_projectId_ruleType_idx` ON `rules` (`projectId`, `ruleType`);
--> statement-breakpoint
CREATE INDEX `projectJobs_projectId_status_idx` ON `projectJobs` (`projectId`, `status`);
--> statement-breakpoint
CREATE INDEX `projectJobs_status_leaseUntil_idx` ON `projectJobs` (`status`, `leaseUntil`);
