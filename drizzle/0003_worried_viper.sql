DELETE ar1
FROM `analysisResults` ar1
INNER JOIN `analysisResults` ar2
  ON ar1.`projectId` = ar2.`projectId`
  AND ar1.`id` < ar2.`id`;
--> statement-breakpoint
ALTER TABLE `analysisResults` ADD CONSTRAINT `analysisResults_projectId_unique` UNIQUE(`projectId`);
