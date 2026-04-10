import { describe, expect, it } from "vitest";
import { DelphiParser } from "./parser";

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
});
