ALTER TABLE `projects` ADD COLUMN `lastAnalyzedAt` timestamp;
--> statement-breakpoint
ALTER TABLE `projectJobs` ADD COLUMN `payloadJson` longtext;
--> statement-breakpoint
ALTER TABLE `projectJobs` ADD COLUMN `activeKey` varchar(32);
--> statement-breakpoint
ALTER TABLE `projectJobs` CHANGE COLUMN `completedAt` `finishedAt` timestamp;
--> statement-breakpoint
CREATE UNIQUE INDEX `projectJobs_active_project_unique` ON `projectJobs` (`projectId`, `activeKey`);
