CREATE TABLE `projectJobs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`userId` int NOT NULL,
	`type` enum('import_zip','import_git','analyze') NOT NULL,
	`status` enum('queued','running','completed','failed') NOT NULL DEFAULT 'queued',
	`progress` int NOT NULL DEFAULT 0,
	`errorCode` varchar(64),
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`startedAt` timestamp,
	`completedAt` timestamp,
	CONSTRAINT `projectJobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `projectJobs_projectId_idx` ON `projectJobs` (`projectId`);
--> statement-breakpoint
CREATE INDEX `projectJobs_userId_idx` ON `projectJobs` (`userId`);
--> statement-breakpoint
CREATE INDEX `projectJobs_status_idx` ON `projectJobs` (`status`);
--> statement-breakpoint
ALTER TABLE `projectJobs` ADD CONSTRAINT `projectJobs_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE `projectJobs` ADD CONSTRAINT `projectJobs_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE cascade;
