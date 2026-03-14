package analyzer

import (
	"fmt"
	"regexp"
	"strings"
)

// SourceLocation 代表程式碼中的位置資訊
type SourceLocation struct {
	File      string
	Line      int
	Column    int
	EndLine   int
	EndColumn int
}

// Symbol 代表一個程式碼符號（函數、方法、查詢等）
type Symbol struct {
	Name        string
	Type        string // "function", "method", "procedure", "query", "table"
	Location    SourceLocation
	Signature   string
	Description string
	Content     string
}

// Dependency 代表符號之間的依賴關係
type Dependency struct {
	Source         *Symbol
	Target         *Symbol
	DependencyType string // "calls", "reads", "writes", "references"
	Location       SourceLocation
}

// FieldReference 代表欄位的讀寫引用
type FieldReference struct {
	TableName     string
	FieldName     string
	OperationType string // "read", "write", "calculate"
	Location      SourceLocation
	Context       string
}

// ParseResult 代表解析結果
type ParseResult struct {
	Symbols          []*Symbol
	Dependencies     []*Dependency
	FieldReferences  []*FieldReference
	MagicValues      []*MagicValue
	Errors           []string
}

// MagicValue 代表程式碼中的魔法值
type MagicValue struct {
	Value    string
	Location SourceLocation
	Context  string
}

// GoParser 解析 Go 程式碼
type GoParser struct {
	content string
	lines   []string
}

// NewGoParser 建立新的 Go 解析器
func NewGoParser(content string) *GoParser {
	lines := strings.Split(content, "\n")
	return &GoParser{
		content: content,
		lines:   lines,
	}
}

// Parse 解析 Go 程式碼
func (p *GoParser) Parse(filePath string) *ParseResult {
	result := &ParseResult{
		Symbols:         make([]*Symbol, 0),
		Dependencies:    make([]*Dependency, 0),
		FieldReferences: make([]*FieldReference, 0),
		MagicValues:     make([]*MagicValue, 0),
		Errors:          make([]string, 0),
	}

	// 解析函數定義
	p.parseFunctions(filePath, result)

	// 解析方法定義
	p.parseMethods(filePath, result)

	// 解析函數呼叫
	p.parseFunctionCalls(filePath, result)

	// 解析資料庫操作
	p.parseDatabaseOperations(filePath, result)

	// 解析魔法值
	p.parseMagicValues(filePath, result)

	return result
}

// parseFunctions 解析 Go 函數定義
func (p *GoParser) parseFunctions(filePath string, result *ParseResult) {
	// 正則表達式匹配 func 定義
	funcRegex := regexp.MustCompile(`(?m)^func\s+([a-zA-Z_]\w*)\s*\((.*?)\)\s*(?:\((.*?)\))?\s*\{`)

	matches := funcRegex.FindAllStringSubmatchIndex(p.content, -1)
	for _, match := range matches {
		startPos := match[0]
		endPos := match[1]

		// 計算行號
		lineNum := strings.Count(p.content[:startPos], "\n") + 1
		funcName := p.content[match[2]:match[3]]
		params := p.content[match[4]:match[5]]

		// 找到函數結束位置
		endLine := p.findBlockEnd(lineNum - 1)

		symbol := &Symbol{
			Name:      funcName,
			Type:      "function",
			Signature: fmt.Sprintf("func %s(%s)", funcName, params),
			Location: SourceLocation{
				File:    filePath,
				Line:    lineNum,
				EndLine: endLine,
			},
			Content: p.extractFunctionContent(lineNum - 1),
		}

		result.Symbols = append(result.Symbols, symbol)
	}
}

// parseMethods 解析 Go 方法定義
func (p *GoParser) parseMethods(filePath string, result *ParseResult) {
	// 正則表達式匹配 func (receiver) 定義
	methodRegex := regexp.MustCompile(`(?m)^func\s*\(\s*([a-zA-Z_]\w*)\s+\*?([a-zA-Z_]\w*)\s*\)\s+([a-zA-Z_]\w*)\s*\((.*?)\)`)

	matches := methodRegex.FindAllStringSubmatchIndex(p.content, -1)
	for _, match := range matches {
		startPos := match[0]
		lineNum := strings.Count(p.content[:startPos], "\n") + 1
		receiver := p.content[match[2]:match[3]]
		receiverType := p.content[match[4]:match[5]]
		methodName := p.content[match[6]:match[7]]
		params := p.content[match[8]:match[9]]

		endLine := p.findBlockEnd(lineNum - 1)

		symbol := &Symbol{
			Name:      fmt.Sprintf("%s.%s", receiverType, methodName),
			Type:      "method",
			Signature: fmt.Sprintf("func (%s %s) %s(%s)", receiver, receiverType, methodName, params),
			Location: SourceLocation{
				File:    filePath,
				Line:    lineNum,
				EndLine: endLine,
			},
			Content: p.extractFunctionContent(lineNum - 1),
		}

		result.Symbols = append(result.Symbols, symbol)
	}
}

// parseFunctionCalls 解析函數呼叫
func (p *GoParser) parseFunctionCalls(filePath string, result *ParseResult) {
	// 簡單的函數呼叫模式
	callRegex := regexp.MustCompile(`([a-zA-Z_]\w*)\s*\(`)

	for i, line := range p.lines {
		matches := callRegex.FindAllStringSubmatchIndex(line, -1)
		for _, match := range matches {
			funcName := line[match[2]:match[3]]

			// 尋找對應的符號
			for _, symbol := range result.Symbols {
				if symbol.Name == funcName || strings.HasSuffix(symbol.Name, "."+funcName) {
					// 記錄依賴關係
					// 這裡簡化處理，實際應該追蹤呼叫者
					_ = symbol
				}
			}
		}
	}
}

// parseDatabaseOperations 解析資料庫操作
func (p *GoParser) parseDatabaseOperations(filePath string, result *ParseResult) {
	// 解析 db.Query, db.Exec 等操作
	dbOpRegex := regexp.MustCompile(`db\.(Query|Exec|QueryRow)\s*\(\s*["` + "`" + `]([^"` + "`" + `]+)`)

	for i, line := range p.lines {
		matches := dbOpRegex.FindAllStringSubmatchIndex(line, -1)
		for _, match := range matches {
			query := line[match[4]:match[5]]
			p.parseSQL(query, filePath, i+1, result)
		}
	}
}

// parseSQL 解析 SQL 語句中的欄位引用
func (p *GoParser) parseSQL(query, filePath string, lineNum int, result *ParseResult) {
	// 簡單的 SQL 解析
	selectRegex := regexp.MustCompile(`(?i)SELECT\s+(.+?)\s+FROM\s+(\w+)`)
	updateRegex := regexp.MustCompile(`(?i)UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE`)
	insertRegex := regexp.MustCompile(`(?i)INSERT\s+INTO\s+(\w+)\s*\((.*?)\)`)

	// 解析 SELECT
	if matches := selectRegex.FindStringSubmatch(query); matches != nil {
		tableName := matches[2]
		fields := strings.Split(matches[1], ",")
		for _, field := range fields {
			field = strings.TrimSpace(field)
			result.FieldReferences = append(result.FieldReferences, &FieldReference{
				TableName:     tableName,
				FieldName:     field,
				OperationType: "read",
				Location: SourceLocation{
					File: filePath,
					Line: lineNum,
				},
				Context: query,
			})
		}
	}

	// 解析 UPDATE
	if matches := updateRegex.FindStringSubmatch(query); matches != nil {
		tableName := matches[1]
		setClause := matches[2]
		fields := strings.Split(setClause, ",")
		for _, field := range fields {
			field = strings.TrimSpace(field)
			parts := strings.Split(field, "=")
			if len(parts) > 0 {
				fieldName := strings.TrimSpace(parts[0])
				result.FieldReferences = append(result.FieldReferences, &FieldReference{
					TableName:     tableName,
					FieldName:     fieldName,
					OperationType: "write",
					Location: SourceLocation{
						File: filePath,
						Line: lineNum,
					},
					Context: query,
				})
			}
		}
	}

	// 解析 INSERT
	if matches := insertRegex.FindStringSubmatch(query); matches != nil {
		tableName := matches[1]
		fieldList := matches[2]
		fields := strings.Split(fieldList, ",")
		for _, field := range fields {
			field = strings.TrimSpace(field)
			result.FieldReferences = append(result.FieldReferences, &FieldReference{
				TableName:     tableName,
				FieldName:     field,
				OperationType: "write",
				Location: SourceLocation{
					File: filePath,
					Line: lineNum,
				},
				Context: query,
			})
		}
	}
}

// parseMagicValues 解析魔法值
func (p *GoParser) parseMagicValues(filePath string, result *ParseResult) {
	// 尋找常見的魔法值模式
	magicPatterns := []struct {
		pattern string
		desc    string
	}{
		{`==\s*["']([YN])["']`, "Y/N flag"},
		{`==\s*["']([0-9]{2})["']`, "numeric code"},
		{`==\s*["']([0-9]{4}-[0-9]{2}-[0-9]{2})["']`, "date format"},
	}

	for i, line := range p.lines {
		for _, mp := range magicPatterns {
			regex := regexp.MustCompile(mp.pattern)
			matches := regex.FindAllStringSubmatchIndex(line, -1)
			for _, match := range matches {
				value := line[match[2]:match[3]]
				result.MagicValues = append(result.MagicValues, &MagicValue{
					Value: value,
					Location: SourceLocation{
						File: filePath,
						Line: i + 1,
					},
					Context: mp.desc,
				})
			}
		}
	}
}

// findBlockEnd 找到程式碼區塊的結束行
func (p *GoParser) findBlockEnd(startLine int) int {
	braceCount := 0
	foundStart := false

	for i := startLine; i < len(p.lines); i++ {
		line := p.lines[i]
		for _, char := range line {
			if char == '{' {
				foundStart = true
				braceCount++
			} else if char == '}' {
				braceCount--
				if foundStart && braceCount == 0 {
					return i + 1
				}
			}
		}
	}

	return startLine + 1
}

// extractFunctionContent 提取函數內容
func (p *GoParser) extractFunctionContent(startLine int) string {
	endLine := p.findBlockEnd(startLine)
	if endLine > len(p.lines) {
		endLine = len(p.lines)
	}
	return strings.Join(p.lines[startLine:endLine], "\n")
}

// SQLParser 解析 SQL 程式碼
type SQLParser struct {
	content string
	lines   []string
}

// NewSQLParser 建立新的 SQL 解析器
func NewSQLParser(content string) *SQLParser {
	lines := strings.Split(content, "\n")
	return &SQLParser{
		content: content,
		lines:   lines,
	}
}

// Parse 解析 SQL 程式碼
func (p *SQLParser) Parse(filePath string) *ParseResult {
	result := &ParseResult{
		Symbols:         make([]*Symbol, 0),
		Dependencies:    make([]*Dependency, 0),
		FieldReferences: make([]*FieldReference, 0),
		MagicValues:     make([]*MagicValue, 0),
		Errors:          make([]string, 0),
	}

	// 解析表定義
	p.parseTables(filePath, result)

	// 解析查詢
	p.parseQueries(filePath, result)

	// 解析欄位引用
	p.parseFieldReferences(filePath, result)

	return result
}

// parseTables 解析 SQL 表定義
func (p *SQLParser) parseTables(filePath string, result *ParseResult) {
	tableRegex := regexp.MustCompile(`(?i)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(`)

	for i, line := range p.lines {
		matches := tableRegex.FindStringSubmatchIndex(line, -1)
		if matches != nil {
			tableName := line[matches[2]:matches[3]]
			endLine := p.findTableEnd(i)

			symbol := &Symbol{
				Name: tableName,
				Type: "table",
				Location: SourceLocation{
					File:    filePath,
					Line:    i + 1,
					EndLine: endLine,
				},
				Content: strings.Join(p.lines[i:endLine], "\n"),
			}

			result.Symbols = append(result.Symbols, symbol)
		}
	}
}

// parseQueries 解析 SQL 查詢
func (p *SQLParser) parseQueries(filePath string, result *ParseResult) {
	queryRegex := regexp.MustCompile(`(?i)(SELECT|INSERT|UPDATE|DELETE|PROCEDURE)\s+`)

	for i, line := range p.lines {
		if queryRegex.MatchString(line) {
			// 簡化：將每個 SELECT/INSERT/UPDATE 視為一個符號
			symbol := &Symbol{
				Type: "query",
				Location: SourceLocation{
					File: filePath,
					Line: i + 1,
				},
				Content: line,
			}
			result.Symbols = append(result.Symbols, symbol)
		}
	}
}

// parseFieldReferences 解析 SQL 中的欄位引用
func (p *SQLParser) parseFieldReferences(filePath string, result *ParseResult) {
	// 這個方法會在 parseSQL (在 GoParser 中) 中被調用
	// 這裡可以添加 SQL 特定的欄位解析邏輯
}

// findTableEnd 找到表定義的結束
func (p *SQLParser) findTableEnd(startLine int) int {
	for i := startLine; i < len(p.lines); i++ {
		if strings.Contains(p.lines[i], ");") {
			return i + 1
		}
	}
	return startLine + 1
}
