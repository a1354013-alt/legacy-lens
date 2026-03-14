CREATE TABLE `analysisResults` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`flowMarkdown` text,
	`dataDependencyMarkdown` text,
	`risksMarkdown` text,
	`rulesYaml` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `analysisResults_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `dependencies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`sourceSymbolId` int NOT NULL,
	`targetSymbolId` int NOT NULL,
	`dependencyType` enum('calls','reads','writes','references') NOT NULL,
	`lineNumber` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `dependencies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `fieldDependencies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`fieldId` int NOT NULL,
	`symbolId` int NOT NULL,
	`operationType` enum('read','write','calculate') NOT NULL,
	`lineNumber` int,
	`context` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fieldDependencies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `fields` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`tableName` varchar(255) NOT NULL,
	`fieldName` varchar(255) NOT NULL,
	`fieldType` varchar(100),
	`description` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fields_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`filePath` varchar(512) NOT NULL,
	`fileName` varchar(255) NOT NULL,
	`fileType` varchar(50),
	`content` text,
	`lineCount` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`language` enum('go','delphi','sql') NOT NULL,
	`sourceType` enum('upload','git') NOT NULL,
	`sourceUrl` text,
	`status` enum('pending','analyzing','completed','failed') DEFAULT 'pending',
	`analysisProgress` int DEFAULT 0,
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `risks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`riskType` enum('magic_value','multiple_writes','missing_condition','format_conversion','inconsistent_logic','other') NOT NULL,
	`severity` enum('low','medium','high','critical') NOT NULL,
	`title` varchar(255) NOT NULL,
	`description` text,
	`sourceFile` varchar(512),
	`lineNumber` int,
	`codeSnippet` text,
	`recommendation` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `risks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`ruleType` enum('validation','format','magic_value','calculation') NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`condition` text,
	`sourceFile` varchar(512),
	`lineNumber` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `symbols` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`fileId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`type` enum('function','procedure','method','query','table') NOT NULL,
	`startLine` int NOT NULL,
	`endLine` int NOT NULL,
	`signature` text,
	`description` text,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `symbols_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `analysisResults_projectId_idx` ON `analysisResults` (`projectId`);--> statement-breakpoint
CREATE INDEX `dependencies_projectId_idx` ON `dependencies` (`projectId`);--> statement-breakpoint
CREATE INDEX `dependencies_sourceSymbolId_idx` ON `dependencies` (`sourceSymbolId`);--> statement-breakpoint
CREATE INDEX `dependencies_targetSymbolId_idx` ON `dependencies` (`targetSymbolId`);--> statement-breakpoint
CREATE INDEX `fieldDependencies_projectId_idx` ON `fieldDependencies` (`projectId`);--> statement-breakpoint
CREATE INDEX `fieldDependencies_fieldId_idx` ON `fieldDependencies` (`fieldId`);--> statement-breakpoint
CREATE INDEX `fieldDependencies_symbolId_idx` ON `fieldDependencies` (`symbolId`);--> statement-breakpoint
CREATE INDEX `fields_projectId_idx` ON `fields` (`projectId`);--> statement-breakpoint
CREATE INDEX `files_projectId_idx` ON `files` (`projectId`);--> statement-breakpoint
CREATE INDEX `projects_userId_idx` ON `projects` (`userId`);--> statement-breakpoint
CREATE INDEX `risks_projectId_idx` ON `risks` (`projectId`);--> statement-breakpoint
CREATE INDEX `rules_projectId_idx` ON `rules` (`projectId`);--> statement-breakpoint
CREATE INDEX `symbols_projectId_idx` ON `symbols` (`projectId`);--> statement-breakpoint
CREATE INDEX `symbols_fileId_idx` ON `symbols` (`fileId`);