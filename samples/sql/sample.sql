-- Sample SQL script for Legacy Lens demo
-- This demonstrates SQL analysis capabilities including table operations, field references, and potential risks

-- Create users table
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    last_login_at TIMESTAMP NULL
);

-- Create orders table with foreign key relationship
CREATE TABLE orders (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    order_number VARCHAR(50) NOT NULL UNIQUE,
    status ENUM('pending', 'processing', 'shipped', 'delivered', 'cancelled') DEFAULT 'pending',
    total_amount DECIMAL(10, 2) NOT NULL,
    discount_amount DECIMAL(10, 2) DEFAULT 0.00,
    shipping_address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create order_items table
CREATE TABLE order_items (
    id INT PRIMARY KEY AUTO_INCREMENT,
    order_id INT NOT NULL,
    product_id INT NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    unit_price DECIMAL(10, 2) NOT NULL,
    subtotal DECIMAL(10, 2) NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- Insert sample users
INSERT INTO users (username, email, password_hash) VALUES
('john_doe', 'john@example.com', 'hash_abc123'),
('jane_smith', 'jane@example.com', 'hash_def456'),
('bob_wilson', 'bob@example.com', 'hash_ghi789');

-- Complex query with multiple table joins
SELECT 
    u.username,
    u.email,
    o.order_number,
    o.status,
    o.total_amount,
    COUNT(oi.id) AS item_count
FROM users u
INNER JOIN orders o ON u.id = o.user_id
LEFT JOIN order_items oi ON o.id = oi.order_id
WHERE u.is_active = TRUE
    AND o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
GROUP BY u.id, o.id
HAVING item_count > 0
ORDER BY o.created_at DESC;

-- Update with dynamic value (potential risk: magic value)
UPDATE orders 
SET status = 'processing',
    updated_at = NOW()
WHERE status = 'pending'
    AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY);

-- Delete old inactive users (demonstrates soft delete pattern consideration)
-- Note: In production, consider using is_active flag instead of hard delete
DELETE FROM users 
WHERE is_active = FALSE 
    AND updated_at < DATE_SUB(NOW(), INTERVAL 90 DAY);

-- Stored procedure example
DELIMITER //
CREATE PROCEDURE GetUserOrderSummary(IN userId INT)
BEGIN
    SELECT 
        u.username,
        u.email,
        COUNT(o.id) AS total_orders,
        SUM(o.total_amount) AS lifetime_value,
        AVG(o.total_amount) AS avg_order_value,
        MAX(o.created_at) AS last_order_date
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id
    WHERE u.id = userId
    GROUP BY u.id;
END //
DELIMITER ;

-- View for reporting
CREATE VIEW v_monthly_sales AS
SELECT 
    DATE_FORMAT(created_at, '%Y-%m') AS month,
    COUNT(*) AS order_count,
    SUM(total_amount) AS total_revenue,
    AVG(total_amount) AS avg_order_value
FROM orders
WHERE status != 'cancelled'
GROUP BY DATE_FORMAT(created_at, '%Y-%m')
ORDER BY month DESC;

-- Trigger example: auto-calculate subtotal
DELIMITER //
CREATE TRIGGER before_order_item_insert
BEFORE INSERT ON order_items
FOR EACH ROW
BEGIN
    SET NEW.subtotal = NEW.quantity * NEW.unit_price;
END //
DELIMITER ;
