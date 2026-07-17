ALTER TABLE `analysisResults` DROP INDEX `analysisResults_projectId_unique`;
--> statement-breakpoint
ALTER TABLE `analysisResults`
  ADD COLUMN `runNumber` int NOT NULL DEFAULT 1,
  ADD COLUMN `jobId` int,
  ADD COLUMN `analyzerVersion` varchar(64) NOT NULL DEFAULT 'legacy',
  ADD COLUMN `sourceFingerprint` varchar(64),
  ADD COLUMN `snapshotSchemaVersion` int NOT NULL DEFAULT 1,
  ADD COLUMN `snapshotJson` longtext,
  ADD COLUMN `completedAt` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `analysisResults`
  ADD CONSTRAINT `analysisResults_jobId_projectJobs_id_fk`
  FOREIGN KEY (`jobId`) REFERENCES `projectJobs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX `analysisResults_projectId_runNumber_unique` ON `analysisResults` (`projectId`,`runNumber`);
--> statement-breakpoint
CREATE INDEX `analysisResults_projectId_createdAt_id_idx` ON `analysisResults` (`projectId`,`createdAt`,`id`);
--> statement-breakpoint
UPDATE `analysisResults` SET `runNumber` = 1 WHERE `runNumber` IS NULL OR `runNumber` = 0;
--> statement-breakpoint
CREATE TABLE `analysisBaselines` (
  `projectId` int NOT NULL,
  `analysisResultId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `analysisBaselines_projectId` PRIMARY KEY(`projectId`),
  CONSTRAINT `analysisBaselines_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `analysisBaselines_analysisResultId_analysisResults_id_fk` FOREIGN KEY (`analysisResultId`) REFERENCES `analysisResults`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE INDEX `analysisBaselines_analysisResultId_idx` ON `analysisBaselines` (`analysisResultId`);
