DROP PROCEDURE IF EXISTS `legacy_lens_preflight_0016`;--> statement-breakpoint
CREATE PROCEDURE `legacy_lens_preflight_0016`()
BEGIN
  DECLARE invalid_baseline_count INT DEFAULT 0;

  SELECT COUNT(*)
    INTO invalid_baseline_count
  FROM `analysisBaselines` b
  LEFT JOIN `analysisResults` r
    ON r.`id` = b.`analysisResultId`
   AND r.`projectId` = b.`projectId`
  WHERE r.`id` IS NULL;

  IF invalid_baseline_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = '0016 preflight failed: analysisBaselines contains rows without a matching analysisResults(projectId,id) pair.';
  END IF;
END;--> statement-breakpoint
CALL `legacy_lens_preflight_0016`();--> statement-breakpoint
DROP PROCEDURE `legacy_lens_preflight_0016`;--> statement-breakpoint
CREATE UNIQUE INDEX `analysisResults_projectId_id_unique` ON `analysisResults` (`projectId`,`id`);--> statement-breakpoint
ALTER TABLE `analysisBaselines` ADD CONSTRAINT `analysisBaselines_projectId_analysisResultId_fk` FOREIGN KEY (`projectId`,`analysisResultId`) REFERENCES `analysisResults`(`projectId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE;
