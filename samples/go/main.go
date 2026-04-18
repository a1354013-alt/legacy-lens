package main

import (
"database/sql"
"fmt"
"log"

_ "github.com/go-sql-driver/mysql"
)

// User represents a user in the system
type User struct {
ID    int
Name  string
Email string
}

// UserService handles user operations
type UserService struct {
db *sql.DB
}

// NewUserService creates a new user service
func NewUserService(db *sql.DB) *UserService {
return &UserService{db: db}
}

// GetUserByID retrieves a user by ID
func (s *UserService) GetUserByID(id int) (*User, error) {
row := s.db.QueryRow("SELECT id, name, email FROM users WHERE id = ?", id)

var user User
err := row.Scan(&user.ID, &user.Name, &user.Email)
if err != nil {
return nil, err
}

return &user, nil
}

// CreateUser creates a new user
func (s *UserService) CreateUser(name, email string) (int64, error) {
result, err := s.db.Exec(
"INSERT INTO users (name, email) VALUES (?, ?)",
name, email,
)
if err != nil {
return 0, err
}

return result.LastInsertId()
}

// CalculateDiscount applies business logic for discounts
func CalculateDiscount(amount float64, isVIP bool) float64 {
if isVIP {
return amount * 0.8 // 20% discount for VIP
}
if amount > 1000 {
return amount * 0.9 // 10% discount for large orders
}
return amount
}

func main() {
db, err := sql.Open("mysql", "user:password@tcp(localhost:3306)/legacy_lens")
if err != nil {
log.Fatal(err)
}
defer db.Close()

service := NewUserService(db)

userID, err := service.CreateUser("John Doe", "john@example.com")
if err != nil {
log.Printf("Error creating user: %v", err)
}

user, err := service.GetUserByID(int(userID))
if err != nil {
log.Printf("Error getting user: %v", err)
}

fmt.Printf("User: %+v\n", user)

discount := CalculateDiscount(1500, true)
fmt.Printf("Discounted price: %.2f\n", discount)
}
