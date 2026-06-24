unit Repo;

interface

implementation

procedure SaveOrder;
begin
  Query.ParamByName('OrderId').AsInteger := 42;
end;

end.
