import { describe, expect, it } from "vitest";
import { DelphiParser, DfmParser, GoParser, ParserFactory, extractDelphiUnitInfo, parseDfmContent } from "./parser";

describe("DelphiParser", () => {
  it("captures common method declarations with qualified names", () => {
    const parser = new DelphiParser(
      [
        "procedure TForm1.Button1Click(Sender: TObject);",
        "begin",
        "  inherited;",
        "end;",
        "",
        "class function TInvoiceFactory.Build(const AId: Integer): TInvoice; overload;",
        "begin",
        "end;",
        "",
        "constructor TInvoice.Create;",
        "begin",
        "end;",
      ].join("\n"),
      "invoice.pas"
    );

    const symbols = parser.parseSymbols();

    expect(symbols).toHaveLength(3);
    expect(symbols[0]).toMatchObject({
      name: "Button1Click",
      qualifiedName: "TForm1.Button1Click",
      type: "method",
    });
    expect(symbols[1]).toMatchObject({
      name: "Build",
      qualifiedName: "TInvoiceFactory.Build",
      type: "method",
    });
    expect(symbols[2]).toMatchObject({
      name: "Create",
      qualifiedName: "TInvoice.Create",
      type: "method",
    });
  });

  it("parses Delphi unit name, uses dependencies, and section-scoped symbols", () => {
    const content = [
      "unit Invoice;",
      "interface",
      "uses",
      "  System.SysUtils, Data.DB;",
      "type",
      "  TInvoice = class(TForm)",
      "    procedure ProcessRecord;",
      "  end;",
      "implementation",
      "procedure TInvoice.ProcessRecord;",
      "begin",
      "end;",
      "end.",
    ].join("\n");

    const info = extractDelphiUnitInfo(content);

    expect(info).toEqual({
      unitName: "Invoice",
      usesUnits: ["System.SysUtils", "Data.DB"],
      interfaceSymbols: ["TInvoice", "ProcessRecord"],
      implementationSymbols: ["TInvoice.ProcessRecord"],
    });

    const parser = new DelphiParser(content, "Invoice.pas");
    const symbols = parser.parseSymbols();
    const dependencies = parser.parseDependencies(symbols);

    expect(dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromName: "Invoice",
          toName: "System.SysUtils",
          type: "references",
        }),
        expect.objectContaining({
          fromName: "Invoice",
          toName: "Data.DB",
          type: "references",
        }),
      ])
    );
  });

  it("extracts DFM object metadata and event handlers", () => {
    const dfm = [
      "object Form1: TForm1",
      "  Left = 0",
      "  Top = 0",
      "  object Button1: TButton",
      "    OnClick = Button1Click",
      "  end",
      "end",
    ].join("\n");

    const result = parseDfmContent(dfm, "Form1.dfm");

    expect(result.formName).toBe("Form1");
    expect(result.objects).toHaveLength(2);
    expect(result.objects[1].eventHandlers).toEqual([
      { eventName: "OnClick", handlerName: "Button1Click" },
    ]);

    const parser = new DfmParser(dfm, "Form1.dfm");
    const symbols = parser.parseSymbols();

    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Form1",
          type: "class",
          qualifiedName: "Form1",
        }),
        expect.objectContaining({
          name: "Button1Click",
          qualifiedName: "Button1.Button1Click",
          type: "method",
          description: "DFM event handler for Button1",
        }),
      ])
    );
  });

  it("parses Go structs as classes and preserves descriptions on created symbols", () => {
    const parser = new GoParser(
      [
        "type User struct {",
        "  Name string",
        "}",
        "",
        "func BuildUser() {}",
      ].join("\n"),
      "user.go"
    );

    const symbols = parser.parseSymbols();

    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "User",
          type: "class",
        }),
      ])
    );
  });

  it("keeps ParserFactory support aligned with imported Delphi-related extensions", () => {
    expect(ParserFactory.isLanguageSupported("dfm")).toBe(true);
    expect(ParserFactory.isLanguageSupported("inc")).toBe(true);
    expect(ParserFactory.isLanguageSupported("dpk")).toBe(true);
    expect(ParserFactory.isLanguageSupported("fmx")).toBe(true);
    expect(ParserFactory.createParser("inc", "const Foo = 1;", "types.inc")).toBeInstanceOf(DelphiParser);
    expect(ParserFactory.createParser("fmx", "object Form1: TForm1", "Form1.fmx")).toBeInstanceOf(DelphiParser);
  });

  it("assigns Delphi SQL and field access to the most specific procedure owner", () => {
    const content = [
      "unit InvoiceUnit;",
      "interface",
      "implementation",
      "procedure LoadUsers;",
      "begin",
      "  Query.SQL.Text := 'SELECT u.Name FROM dbo.Users u WHERE u.Id = :Id';",
      "  Query.FieldByName('Name').AsString := '';",
      "end;",
      "",
      "procedure SaveOrders;",
      "begin",
      "  Query.SQL.Text := 'UPDATE ERP.SIGNB SET MARK_2 = :P1 WHERE MARK_2 = :P2';",
      "  Query.ParamByName('MARK_2').AsString := 'Y';",
      "end;",
      "end.",
    ].join("\n");

    const parser = new DelphiParser(content, "InvoiceUnit.pas");
    const symbols = parser.parseSymbols();
    const references = parser.parseFieldReferences(symbols);

    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "dbo.Users",
          field: "Name",
          symbolName: "LoadUsers",
          symbolStableKey: expect.stringContaining("LoadUsers"),
        }),
        expect.objectContaining({
          table: "ERP.SIGNB",
          field: "MARK_2",
          symbolName: "SaveOrders",
          symbolStableKey: expect.stringContaining("SaveOrders"),
        }),
      ])
    );
  });

  it("tracks Go function and method block ranges without regex lastIndex bleed", () => {
    const parser = new GoParser(
      [
        "package main",
        "",
        "type Service struct {}",
        "",
        "func (s *Service) Run() {",
        "  if ready {",
        "    call()",
        "  }",
        "}",
        "",
        "func main() {",
        "  for i := 0; i < 1; i++ {",
        "    println(i)",
        "  }",
        "}",
      ].join("\n"),
      "main.go"
    );

    const symbols = parser.parseSymbols();

    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Run", startLine: 5, endLine: 9, type: "method" }),
        expect.objectContaining({ name: "main", startLine: 11, endLine: 15, type: "function" }),
      ])
    );
  });

  it("falls back to symbol name when a Delphi procedure lacks qualifiedName", () => {
    const content = [
      "unit InvoiceUnit;",
      "interface",
      "implementation",
      "procedure LoadUsers;",
      "begin",
      "  Query.FieldByName('Name').AsString := '';",
      "end;",
      "end.",
    ].join("\n");

    const parser = new DelphiParser(content, "InvoiceUnit.pas");
    const symbols = parser.parseSymbols().map((symbol) =>
      symbol.name === "LoadUsers" ? { ...symbol, qualifiedName: undefined } : symbol
    );
    const references = parser.parseFieldReferences(symbols);

    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "delphi",
          field: "Name",
          symbolName: "LoadUsers",
          symbolStableKey: expect.stringContaining("LoadUsers"),
        }),
      ])
    );
  });
});

describe("SQLParser", () => {
  it("supports schema-qualified SELECT, JOIN aliases, UPDATE, INSERT, and DELETE statements", () => {
    const parser = ParserFactory.createParser(
      "sql",
      [
        "SELECT u.Name, o.Amount",
        "FROM dbo.Users u",
        "JOIN dbo.Orders o ON u.Id = o.UserId;",
        "UPDATE dbo.Users SET Name = 'A', Email = 'B' WHERE Id = 1;",
        "INSERT INTO ERP.SIGNB (MARK_2, Name) VALUES ('Y', 'A');",
        "DELETE FROM dbo.Users WHERE Id = 1;",
      ].join("\n"),
      "queries.sql"
    );

    const symbols = parser.parseSymbols();
    const references = parser.parseFieldReferences(symbols);

    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "dbo.Users", field: "Name", type: "read" }),
        expect.objectContaining({ table: "dbo.Orders", field: "Amount", type: "read" }),
        expect.objectContaining({ table: "dbo.Users", field: "Id", type: "read" }),
        expect.objectContaining({ table: "dbo.Orders", field: "UserId", type: "read" }),
        expect.objectContaining({ table: "dbo.Users", field: "Name", type: "write" }),
        expect.objectContaining({ table: "dbo.Users", field: "Email", type: "write" }),
        expect.objectContaining({ table: "dbo.Users", field: "Id", type: "read" }),
        expect.objectContaining({ table: "ERP.SIGNB", field: "MARK_2", type: "write" }),
        expect.objectContaining({ table: "dbo.Users", field: "*", type: "write" }),
      ])
    );
  });

  it("treats UPDATE SET columns as writes and WHERE or JOIN columns as reads only", () => {
    const parser = ParserFactory.createParser(
      "sql",
      [
        "UPDATE dbo.Users",
        "SET Name = 'A', Email = 'B'",
        "WHERE Id = 1;",
        "",
        "SELECT u.Name, o.Amount",
        "FROM dbo.Users u",
        "JOIN dbo.Orders o ON u.Id = o.UserId",
        "WHERE o.Amount > 0;",
      ].join("\n"),
      "queries.sql"
    );

    const references = parser.parseFieldReferences(parser.parseSymbols());
    const updateReads = references.filter(
      (reference) => reference.type === "read" && reference.context?.startsWith("UPDATE dbo.Users")
    );
    const updateWrites = references.filter(
      (reference) => reference.type === "write" && reference.context?.startsWith("UPDATE dbo.Users")
    );

    expect(updateWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "Name" }),
        expect.objectContaining({ field: "Email" }),
      ])
    );
    expect(updateReads).toEqual([expect.objectContaining({ field: "Id" })]);
    expect(updateReads.some((reference) => reference.field === "Name")).toBe(false);
    expect(updateReads.some((reference) => reference.field === "Email")).toBe(false);
    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "dbo.Users", field: "Name", type: "read" }),
        expect.objectContaining({ table: "dbo.Orders", field: "Amount", type: "read" }),
        expect.objectContaining({ table: "dbo.Users", field: "Id", type: "read" }),
        expect.objectContaining({ table: "dbo.Orders", field: "UserId", type: "read" }),
      ])
    );
  });

  it("keeps schema-qualified table names intact across SELECT, UPDATE, INSERT, and DELETE", () => {
    const parser = ParserFactory.createParser(
      "sql",
      [
        "SELECT amount FROM public.orders WHERE amount > 0;",
        "UPDATE dbo.Users SET Name = 'A' WHERE Id = 1;",
        "INSERT INTO ERP.SIGNB (MARK_2) VALUES ('Y');",
        "DELETE FROM public.orders WHERE amount > 0;",
      ].join("\n"),
      "qualified.sql"
    );

    const references = parser.parseFieldReferences(parser.parseSymbols());

    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "public.orders", field: "amount", type: "read" }),
        expect.objectContaining({ table: "dbo.Users", field: "Name", type: "write" }),
        expect.objectContaining({ table: "dbo.Users", field: "Id", type: "read" }),
        expect.objectContaining({ table: "ERP.SIGNB", field: "MARK_2", type: "write" }),
        expect.objectContaining({ table: "public.orders", field: "*", type: "write" }),
      ])
    );
  });

  it("extracts SQL from multi-line and concatenated Go/Delphi strings", () => {
    const goParser = new GoParser(
      [
        "func load() {",
        '  query := "SELECT u.Name, o.Amount " +',
        '    "FROM dbo.Users u JOIN dbo.Orders o ON u.Id = o.UserId"',
        "}",
      ].join("\n"),
      "main.go"
    );

    const goSymbols = goParser.parseSymbols();
    const goReferences = goParser.parseFieldReferences(goSymbols);
    expect(goReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "dbo.Users", field: "Name", symbolName: "load" }),
        expect.objectContaining({ table: "dbo.Orders", field: "Amount", symbolName: "load" }),
      ])
    );

    const delphiParser = new DelphiParser(
      [
        "unit Repo;",
        "interface",
        "implementation",
        "procedure BuildQuery;",
        "begin",
        "  Query.SQL.Text := 'INSERT INTO dbo.Users (Name, Email) ' +",
        "    'VALUES (:Name, :Email)';",
        "end;",
        "end.",
      ].join("\n"),
      "Repo.pas"
    );

    const delphiSymbols = delphiParser.parseSymbols();
    const delphiReferences = delphiParser.parseFieldReferences(delphiSymbols);
    expect(delphiReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "dbo.Users", field: "Name", type: "write", symbolName: "BuildQuery" }),
        expect.objectContaining({ table: "dbo.Users", field: "Email", type: "write", symbolName: "BuildQuery" }),
      ])
    );
  });

  it("handles CTEs, nested queries, insert-select, aliases, quoted identifiers, and function-call commas", () => {
    const parser = ParserFactory.createParser(
      "sql",
      [
        "WITH recent_orders AS (",
        '  SELECT o."UserId", SUM(o."Amount") AS total_amount',
        '  FROM "sales"."Orders" o',
        '  WHERE o."Status" = \'paid\'',
        '  GROUP BY o."UserId"',
        ")",
        'INSERT INTO "analytics"."UserTotals" ("UserId", "TotalAmount")',
        'SELECT u."Id", COALESCE(ro.total_amount, 0)',
        'FROM "dbo"."Users" u',
        'LEFT JOIN recent_orders ro ON ro."UserId" = u."Id"',
        'WHERE EXISTS (SELECT 1 FROM "audit"."Logins" l WHERE l."UserId" = u."Id");',
      ].join("\n"),
      "edge-cases.sql"
    );

    const references = parser.parseFieldReferences(parser.parseSymbols());

    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "analytics.UserTotals", field: "UserId", type: "write" }),
        expect.objectContaining({ table: "analytics.UserTotals", field: "TotalAmount", type: "write" }),
        expect.objectContaining({ table: "dbo.Users", field: "Id", type: "read" }),
        expect.objectContaining({ table: "sales.Orders", field: "UserId", type: "read" }),
        expect.objectContaining({ table: "sales.Orders", field: "Amount", type: "read" }),
        expect.objectContaining({ table: "sales.Orders", field: "Status", type: "read" }),
        expect.objectContaining({ table: "audit.Logins", field: "UserId", type: "read" }),
      ])
    );
  });

  it("supports SQL Server bracket identifiers without flattening names or dropping spaces", () => {
    const parser = ParserFactory.createParser(
      "sql",
      [
        "CREATE TABLE [dbo].[Users] ([UserId] INT, [User Name] NVARCHAR(255));",
        "CREATE TABLE [Order Details] ([Order Id] INT, [UserId] INT);",
        "SELECT [UserId], [User Name] FROM [dbo].[Users];",
      ].join("\n"),
      "brackets.sql"
    );

    const symbols = parser.parseSymbols();
    const references = parser.parseFieldReferences(symbols);

    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "dbo.Users", type: "table" }),
        expect.objectContaining({ name: "Order Details", type: "table" }),
      ])
    );
    expect(references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "dbo.Users", field: "UserId", type: "read" }),
        expect.objectContaining({ table: "dbo.Users", field: "User Name", type: "read" }),
      ])
    );
  });
});
