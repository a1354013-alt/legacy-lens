import { describe, expect, it } from "vitest";
import { DelphiParser, DfmParser, extractDelphiUnitInfo, parseDfmContent } from "./parser";

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
        }),
      ])
    );
  });
});
