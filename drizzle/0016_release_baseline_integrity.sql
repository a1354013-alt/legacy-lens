CREATE UNIQUE INDEX `analysisResults_projectId_id_unique` ON `analysisResults` (`projectId`,`id`);--> statement-breakpoint
ALTER TABLE `analysisBaselines` ADD CONSTRAINT `analysisBaselines_projectId_analysisResultId_fk` FOREIGN KEY (`projectId`,`analysisResultId`) REFERENCES `analysisResults`(`projectId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
