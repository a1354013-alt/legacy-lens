unit SampleDataModule;

interface

uses
  System.SysUtils, System.Classes, Data.DB, Data.Win.ADODB;

type
  TdmSample = class(TDataModule)
    connMain: TADOConnection;
    dsUsers: TADODataSet;
    dsOrders: TADODataSet;
    dsOrderItems: TADODataSet;
  private
    function CalculateDiscount(const Amount: Double; const IsVIP: Boolean): Double;
    procedure ValidateUserEmail(const Email: string);
  public
    constructor Create(AOwner: TComponent); override;
    destructor Destroy; override;
    
    // User operations
    function GetUserById(const UserId: Integer): TADODataSet;
    function CreateUser(const Username, Email, PasswordHash: string): Integer;
    procedure UpdateUserLastLogin(const UserId: Integer);
    
    // Order operations
    function CreateOrder(const UserId: Integer; const OrderNumber: string): Integer;
    procedure AddOrderItem(const OrderId, ProductId: Integer; const Quantity: Integer; const UnitPrice: Double);
    function CalculateOrderTotal(const OrderId: Integer): Double;
    
    // Business logic
    procedure ApplyPromoCode(const OrderId: Integer; const PromoCode: string);
    function CheckInventory(const ProductId: Integer): Integer;
  end;

var
  dmSample: TdmSample;

implementation

{%CLASSGROUP 'System.Classes.TPersistent'}

{$R *.dfm}

const
  MAGIC_DISCOUNT_RATE = 0.15;  // Risk: Magic value - should be configurable
  VIP_DISCOUNT_RATE = 0.20;
  MAX_ORDER_ITEMS = 100;
  MIN_ORDER_AMOUNT = 10.00;

constructor TdmSample.Create(AOwner: TComponent);
begin
  inherited;
  connMain.ConnectionString := 'Provider=SQLOLEDB.1;Data Source=localhost;Initial Catalog=legacy_lens;User ID=sa;Password=xxx';
  connMain.LoginPrompt := False;
  connMain.Connected := True;
end;

destructor TdmSample.Destroy;
begin
  if connMain.Connected then
    connMain.Connected := False;
  inherited;
end;

function TdmSample.CalculateDiscount(const Amount: Double; const IsVIP: Boolean): Double;
var
  DiscountRate: Double;
begin
  // Risk: Multiple discount conditions with magic values
  if IsVIP then
    DiscountRate := VIP_DISCOUNT_RATE  // 20% for VIP
  else if Amount > 1000 then
    DiscountRate := 0.10  // 10% for large orders - MAGIC VALUE
  else if Amount > 500 then
    DiscountRate := 0.05  // 5% for medium orders - MAGIC VALUE
  else
    DiscountRate := 0;
  
  Result := Amount * (1 - DiscountRate);
end;

procedure TdmSample.ValidateUserEmail(const Email: string);
begin
  // Risk: Inconsistent validation logic
  if Pos('@', Email) = 0 then
    raise Exception.Create('Invalid email format');
  
  // Missing: domain validation, length check, etc.
end;

function TdmSample.GetUserById(const UserId: Integer): TADODataSet;
begin
  Result := TADODataSet.Create(nil);
  Result.Connection := connMain;
  Result.CommandType := cmdText;
  Result.CommandText := 'SELECT id, username, email, created_at, is_active FROM users WHERE id = :UserId';
  Result.Parameters.ParamByName('UserId').Value := UserId;
  Result.Open;
end;

function TdmSample.CreateUser(const Username, Email, PasswordHash: string): Integer;
var
  NewId: Integer;
begin
  // Risk: Dynamic SQL construction (should use parameterized query)
  connMain.Execute(
    'INSERT INTO users (username, email, password_hash) VALUES (''' + 
    Username + ''', ''' + Email + ''', ''' + PasswordHash + ''')',
    NewId
  );
  Result := NewId;
end;

procedure TdmSample.UpdateUserLastLogin(const UserId: Integer);
begin
  connMain.Execute(
    'UPDATE users SET last_login_at = GETDATE() WHERE id = :UserId',
    [UserId]
  );
end;

function TdmSample.CreateOrder(const UserId: Integer; const OrderNumber: string): Integer;
var
  NewId: Integer;
begin
  connMain.Execute(
    'INSERT INTO orders (user_id, order_number, status, total_amount) ' +
    'VALUES (:UserId, :OrderNumber, ''pending'', 0)',
    [UserId, OrderNumber],
    NewId
  );
  Result := NewId;
end;

procedure TdmSample.AddOrderItem(const OrderId, ProductId: Integer; const Quantity: Integer; const UnitPrice: Double);
var
  Subtotal: Double;
  ItemCount: Integer;
begin
  // Check item count limit
  ItemCount := CheckInventory(ProductId);
  if ItemCount >= MAX_ORDER_ITEMS then
    raise Exception.CreateFmt('Maximum %d items per order exceeded', [MAX_ORDER_ITEMS]);
  
  Subtotal := Quantity * UnitPrice;
  
  connMain.Execute(
    'INSERT INTO order_items (order_id, product_id, quantity, unit_price, subtotal) ' +
    'VALUES (:OrderId, :ProductId, :Quantity, :UnitPrice, :Subtotal)',
    [OrderId, ProductId, Quantity, UnitPrice, Subtotal]
  );
end;

function TdmSample.CalculateOrderTotal(const OrderId: Integer): Double;
var
  ds: TADODataSet;
begin
  ds := TADODataSet.Create(nil);
  try
    ds.Connection := connMain;
    ds.CommandType := cmdText;
    ds.CommandText := 'SELECT ISNULL(SUM(subtotal), 0) AS Total FROM order_items WHERE order_id = :OrderId';
    ds.Parameters.ParamByName('OrderId').Value := OrderId;
    ds.Open;
    Result := ds.FieldByName('Total').AsFloat;
    
    // Update order total
    connMain.Execute(
      'UPDATE orders SET total_amount = :Total WHERE id = :OrderId',
      [Result, OrderId]
    );
  finally
    ds.Free;
  end;
end;

procedure TdmSample.ApplyPromoCode(const OrderId: Integer; const PromoCode: string);
var
  DiscountPercent: Double;
  OrderTotal: Double;
begin
  // Risk: Hard-coded promo codes - should be in database
  if PromoCode = 'SAVE10' then
    DiscountPercent := 10
  else if PromoCode = 'SAVE20' then
    DiscountPercent := 20
  else if PromoCode = 'HALFOFF' then
    DiscountPercent := 50
  else
    raise Exception.Create('Invalid promo code');
  
  OrderTotal := CalculateOrderTotal(OrderId);
  
  // Risk: Format conversion without validation
  connMain.Execute(
    'UPDATE orders SET discount_amount = ' + FloatToStr(OrderTotal * DiscountPercent / 100) + 
    ' WHERE id = ' + IntToStr(OrderId)
  );
end;

function TdmSample.CheckInventory(const ProductId: Integer): Integer;
var
  ds: TADODataSet;
begin
  ds := TADODataSet.Create(nil);
  try
    ds.Connection := connMain;
    ds.CommandType := cmdText;
    ds.CommandText := 'SELECT ISNULL(SUM(quantity), 0) AS Count FROM order_items WHERE product_id = :ProductId';
    ds.Parameters.ParamByName('ProductId').Value := ProductId;
    ds.Open;
    Result := ds.FieldByName('Count').AsInteger;
  finally
    ds.Free;
  end;
end;

end.
