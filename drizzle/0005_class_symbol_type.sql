-- Add 'class' to symbols.type enum
ALTER TABLE `symbols` MODIFY COLUMN `type` enum('function','procedure','method','query','table','class') NOT NULL;
