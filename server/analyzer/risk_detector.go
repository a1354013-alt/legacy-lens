package analyzer

import (
	"fmt"
	"regexp"
	"strings"
)

// RiskDetector 風險檢測引擎
type RiskDetector struct {
	parseResult *ParseResult
}

// RiskItem 風險項目
type RiskItem struct {
	RiskType      string // "magic_value", "multiple_writes", "missing_condition", etc.
	Severity      string // "low", "medium", "high", "critical"
	Title         string
	Description   string
	SourceFile    string
	LineNumber    int
	CodeSnippet   string
	Recommendation string
}

// NewRiskDetector 建立新的風險檢測器
func NewRiskDetector(parseResult *ParseResult) *RiskDetector {
	return &RiskDetector{
		parseResult: parseResult,
	}
}

// Detect 執行風險檢測
func (rd *RiskDetector) Detect() []*RiskItem {
	risks := make([]*RiskItem, 0)

	// 檢測魔法值
	risks = append(risks, rd.detectMagicValues()...)

	// 檢測多處寫入同欄位
	risks = append(risks, rd.detectMultipleWrites()...)

	// 檢測缺少條件的 SQL
	risks = append(risks, rd.detectMissingConditions()...)

	// 檢測日期/金額格式轉換
	risks = append(risks, rd.detectFormatConversions()...)

	// 檢測不一致的邏輯
	risks = append(risks, rd.detectInconsistentLogic()...)

	return risks
}

// detectMagicValues 檢測魔法值
func (rd *RiskDetector) detectMagicValues() []*RiskItem {
	risks := make([]*RiskItem, 0)

	for _, mv := range rd.parseResult.MagicValues {
		// 檢查是否是常見的危險魔法值
		if isRiskyMagicValue(mv.Value) {
			risk := &RiskItem{
				RiskType:   "magic_value",
				Severity:   "medium",
				Title:      fmt.Sprintf("檢測到魔法值: %s", mv.Value),
				Description: fmt.Sprintf("在 %s 中發現魔法值 '%s' (%s)", mv.Location.File, mv.Value, mv.Context),
				SourceFile: mv.Location.File,
				LineNumber: mv.Location.Line,
				CodeSnippet: mv.Context,
				Recommendation: "建議將魔法值提取為具有明確名稱的常數，以提高程式碼可讀性和可維護性。",
			}
			risks = append(risks, risk)
		}
	}

	return risks
}

// detectMultipleWrites 檢測多處寫入同欄位
func (rd *RiskDetector) detectMultipleWrites() []*RiskItem {
	risks := make([]*RiskItem, 0)

	// 統計每個欄位的寫入次數
	writeMap := make(map[string][]*FieldReference)
	for _, ref := range rd.parseResult.FieldReferences {
		if ref.OperationType == "write" {
			key := fmt.Sprintf("%s.%s", ref.TableName, ref.FieldName)
			writeMap[key] = append(writeMap[key], ref)
		}
	}

	// 找出多處寫入的欄位
	for key, refs := range writeMap {
		if len(refs) > 2 {
			parts := strings.Split(key, ".")
			risk := &RiskItem{
				RiskType:   "multiple_writes",
				Severity:   "high",
				Title:      fmt.Sprintf("欄位 %s 有多處寫入", key),
				Description: fmt.Sprintf("欄位 '%s' 在 %d 個不同位置被寫入，可能導致資料一致性問題", key, len(refs)),
				SourceFile: refs[0].Location.File,
				LineNumber: refs[0].Location.Line,
				CodeSnippet: refs[0].Context,
				Recommendation: fmt.Sprintf("建議檢查所有 %d 個寫入位置，確保資料一致性。考慮集中管理此欄位的更新邏輯。", len(refs)),
			}
			risks = append(risks, risk)
		}
	}

	return risks
}

// detectMissingConditions 檢測缺少條件的 SQL
func (rd *RiskDetector) detectMissingConditions() []*RiskItem {
	risks := make([]*RiskItem, 0)

	// 尋找 UPDATE/DELETE 語句但沒有 WHERE 條件
	updateDeleteRegex := regexp.MustCompile(`(?i)(UPDATE|DELETE)\s+(\w+)(?:\s+SET)?(?:\s+[^;]*)?(?:;|$)`)

	for _, symbol := range rd.parseResult.Symbols {
		if symbol.Type == "query" {
			if matches := updateDeleteRegex.FindStringSubmatch(symbol.Content); matches != nil {
				operation := matches[1]
				tableName := matches[2]

				// 檢查是否有 WHERE 條件
				if !strings.Contains(strings.ToUpper(symbol.Content), "WHERE") {
					risk := &RiskItem{
						RiskType:   "missing_condition",
						Severity:   "critical",
						Title:      fmt.Sprintf("%s 語句缺少 WHERE 條件", operation),
						Description: fmt.Sprintf("在 %s:%d 發現 %s 語句操作表 '%s' 但缺少 WHERE 條件，可能影響所有記錄", symbol.Location.File, symbol.Location.Line, operation, tableName),
						SourceFile: symbol.Location.File,
						LineNumber: symbol.Location.Line,
						CodeSnippet: symbol.Content,
						Recommendation: "務必添加 WHERE 條件以限制操作範圍。如果確實需要操作所有記錄，應明確確認並添加註解說明。",
					}
					risks = append(risks, risk)
				}
			}
		}
	}

	return risks
}

// detectFormatConversions 檢測日期/金額格式轉換
func (rd *RiskDetector) detectFormatConversions() []*RiskItem {
	risks := make([]*RiskItem, 0)

	// 尋找日期格式轉換的模式
	dateFormatRegex := regexp.MustCompile(`(?i)(strtotime|date|time\.Parse|format|strftime)\s*\(`)
	amountFormatRegex := regexp.MustCompile(`(?i)(tostring|tostring|parseFloat|parseDecimal|round)\s*\(`)

	for _, symbol := range rd.parseResult.Symbols {
		// 檢查日期格式轉換
		if dateFormatRegex.MatchString(symbol.Content) {
			// 檢查是否有補零邏輯
			if !strings.Contains(symbol.Content, "pad") && !strings.Contains(symbol.Content, "zero") {
				risk := &RiskItem{
					RiskType:   "format_conversion",
					Severity:   "medium",
					Title:      "日期格式轉換可能缺少補零邏輯",
					Description: fmt.Sprintf("在 %s:%d 發現日期格式轉換，但未見補零邏輯", symbol.Location.File, symbol.Location.Line),
					SourceFile: symbol.Location.File,
					LineNumber: symbol.Location.Line,
					CodeSnippet: symbol.Content,
					Recommendation: "確保日期格式轉換時使用正確的補零邏輯（例如 yyyyMMdd 格式需要補零）。",
				}
				risks = append(risks, risk)
			}
		}

		// 檢查金額格式轉換
		if amountFormatRegex.MatchString(symbol.Content) {
			// 檢查是否有小數位處理
			if !strings.Contains(symbol.Content, "decimal") && !strings.Contains(symbol.Content, "precision") {
				risk := &RiskItem{
					RiskType:   "format_conversion",
					Severity:   "high",
					Title:      "金額格式轉換可能缺少小數位處理",
					Description: fmt.Sprintf("在 %s:%d 發現金額格式轉換，但未見小數位處理邏輯", symbol.Location.File, symbol.Location.Line),
					SourceFile: symbol.Location.File,
					LineNumber: symbol.Location.Line,
					CodeSnippet: symbol.Content,
					Recommendation: "確保金額轉換時正確處理小數位。建議使用 Decimal 類型而非 Float 以避免精度問題。",
				}
				risks = append(risks, risk)
			}
		}
	}

	return risks
}

// detectInconsistentLogic 檢測不一致的邏輯
func (rd *RiskDetector) detectInconsistentLogic() []*RiskItem {
	risks := make([]*RiskItem, 0)

	// 尋找相同的欄位被以不同方式處理的情況
	fieldHandlingMap := make(map[string]map[string]int)

	for _, ref := range rd.parseResult.FieldReferences {
		key := fmt.Sprintf("%s.%s", ref.TableName, ref.FieldName)
		if fieldHandlingMap[key] == nil {
			fieldHandlingMap[key] = make(map[string]int)
		}
		fieldHandlingMap[key][ref.Context]++
	}

	// 檢查是否有不一致的處理
	for key, contexts := range fieldHandlingMap {
		if len(contexts) > 2 {
			risk := &RiskItem{
				RiskType:   "inconsistent_logic",
				Severity:   "medium",
				Title:      fmt.Sprintf("欄位 %s 有不一致的處理邏輯", key),
				Description: fmt.Sprintf("欄位 '%s' 在不同位置以不同方式被處理，可能導致邏輯不一致", key),
				Recommendation: "建議檢查所有對此欄位的處理邏輯，確保一致性。考慮統一處理方式。",
			}
			risks = append(risks, risk)
		}
	}

	return risks
}

// isRiskyMagicValue 判斷是否是危險的魔法值
func isRiskyMagicValue(value string) bool {
	riskyPatterns := []string{
		"^[YN]$",           // Y/N 標記
		"^[0-9]{2}$",       // 兩位數代碼
		"^[0-9]{4}$",       // 四位數代碼
		"^00$", "^01$", "^99$", // 特殊代碼
	}

	for _, pattern := range riskyPatterns {
		if matched, _ := regexp.MatchString(pattern, value); matched {
			return true
		}
	}

	return false
}
