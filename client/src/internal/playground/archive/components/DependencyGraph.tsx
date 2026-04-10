import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Loader2, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface DependencyNode {
  id: string;
  name: string;
  type: "field" | "function" | "table";
  language?: string;
  file?: string;
  line?: number;
}

export interface DependencyLink {
  source: string;
  target: string;
  type: "read" | "write" | "calculate" | "call";
  description?: string;
}

interface DependencyGraphProps {
  nodes: DependencyNode[];
  links: DependencyLink[];
  title?: string;
  isLoading?: boolean;
}

export default function DependencyGraph({
  nodes,
  links,
  title = "欄位依賴圖",
  isLoading = false,
}: DependencyGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedNode, setSelectedNode] = useState<DependencyNode | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const simulationRef = useRef<any | null>(null);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0 || isLoading) return;

    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth;
    const height = 600;

    // 清空舊的 SVG
    d3.select(svgRef.current).selectAll("*").remove();

    // 建立 SVG
    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .style("background", "#f8fafc")
      .style("border", "1px solid #e2e8f0")
      .style("border-radius", "8px");

    // 建立 group 用於縮放和平移
    const g = svg.append("g");

    // 定義箭頭標記
    svg
      .append("defs")
      .selectAll("marker")
      .data(["read", "write", "calculate", "call"])
      .enter()
      .append("marker")
      .attr("id", (d: any) => `arrow-${d}`)
      .attr("markerWidth", 10)
      .attr("markerHeight", 10)
      .attr("refX", 20)
      .attr("refY", 3)
      .attr("orient", "auto")
      .append("path")
      .attr("d", "M0,0 L0,6 L9,3 z")
      .attr("fill", (d: any) => {
        const colorMap: Record<string, string> = {
          read: "#3b82f6",
          write: "#ef4444",
          calculate: "#f59e0b",
          call: "#8b5cf6",
        };
        return colorMap[d] || "#6b7280";
      });

    // 建立力導向圖
    const simulation: any = d3
      .forceSimulation(nodes as any)
      .force(
        "link",
        d3
          .forceLink(links as any)
          .id((d: any) => d.id)
          .distance(100)
          .strength(0.5)
      )
      .force("charge", d3.forceManyBody().strength(-300))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(40));

    simulationRef.current = simulation;

    // 繪製連線
    const link = g
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("stroke", (d: any) => {
        const colorMap: Record<string, string> = {
          read: "#3b82f6",
          write: "#ef4444",
          calculate: "#f59e0b",
          call: "#8b5cf6",
        };
        return colorMap[d.type] || "#d1d5db";
      })
      .attr("stroke-width", 2)
      .attr("marker-end", (d: any) => `url(#arrow-${d.type})`)
      .attr("opacity", 0.6);

    // 繪製節點
    const node = g
      .selectAll("circle")
      .data(nodes)
      .enter()
      .append("circle")
      .attr("r", (d: any) => (d.type === "table" ? 12 : 8))
      .attr("fill", (d: any) => {
        const colorMap: Record<string, string> = {
          field: "#06b6d4",
          function: "#8b5cf6",
          table: "#ec4899",
        };
        return colorMap[d.type] || "#6b7280";
      })
      .attr("stroke", "#ffffff")
      .attr("stroke-width", 2)
      .style("cursor", "pointer")
      .on("click", (event: any, d: any) => {
        event.stopPropagation();
        setSelectedNode(d);
      })
      .on("mouseover", function (this: any) {
        d3.select(this).attr("r", (d: any) => (d.type === "table" ? 16 : 12));
      })
      .on("mouseout", function (this: any) {
        d3.select(this).attr("r", (d: any) => (d.type === "table" ? 12 : 8));
      });

    // 添加標籤
    const label = g
      .selectAll("text")
      .data(nodes)
      .enter()
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "0.3em")
      .attr("font-size", "11px")
      .attr("fill", "#1e293b")
      .attr("pointer-events", "none")
      .text((d: any) => d.name.substring(0, 10));

    // 更新位置
    simulation.on("tick", () => {
      link
        .attr("x1", (d: any) => d.source.x)
        .attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x)
        .attr("y2", (d: any) => d.target.y);

      node.attr("cx", (d: any) => d.x).attr("cy", (d: any) => d.y);

      label.attr("x", (d: any) => d.x).attr("y", (d: any) => d.y);
    });

    // 拖拽功能
    const drag = d3
      .drag<SVGCircleElement, DependencyNode>()
      .on("start", (event: any, d: any) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event: any, d: any) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event: any, d: any) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    node.call(drag as any);

    // 縮放功能
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .on("zoom", (event: any) => {
        g.attr("transform", event.transform);
        setZoomLevel(event.transform.k);
      });

    svg.call(zoom as any);

    // 點擊背景取消選擇
    svg.on("click", () => {
      setSelectedNode(null);
    });

    return () => {
      simulation.stop();
    };
  }, [nodes, links, isLoading]);

  const handleZoomIn = () => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.transition().duration(300).call(d3.zoom<SVGSVGElement, unknown>().scaleBy as any, 1.2);
  };

  const handleZoomOut = () => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.transition().duration(300).call(d3.zoom<SVGSVGElement, unknown>().scaleBy as any, 0.8);
  };

  const handleReset = () => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg
      .transition()
      .duration(300)
      .call(d3.zoom<SVGSVGElement, unknown>().transform as any, d3.zoomIdentity);
  };

  const linkTypeStats = {
    read: links.filter((l) => l.type === "read").length,
    write: links.filter((l) => l.type === "write").length,
    calculate: links.filter((l) => l.type === "calculate").length,
    call: links.filter((l) => l.type === "call").length,
  };

  const nodeTypeStats = {
    field: nodes.filter((n) => n.type === "field").length,
    function: nodes.filter((n) => n.type === "function").length,
    table: nodes.filter((n) => n.type === "table").length,
  };

  return (
    <Card className="border-slate-200">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>
              {nodes.length} 個節點，{links.length} 條依賴關係
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleZoomIn} title="放大">
              <ZoomIn className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={handleZoomOut} title="縮小">
              <ZoomOut className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="outline" onClick={handleReset} title="重置">
              <RotateCcw className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="graph" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="graph">圖表</TabsTrigger>
            <TabsTrigger value="legend">圖例</TabsTrigger>
            <TabsTrigger value="details">詳情</TabsTrigger>
          </TabsList>

          <TabsContent value="graph" className="space-y-4">
            <div ref={containerRef} className="w-full bg-white rounded-lg border border-slate-200">
              {isLoading ? (
                <div className="h-96 flex items-center justify-center">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                </div>
              ) : nodes.length === 0 ? (
                <div className="h-96 flex items-center justify-center text-slate-500">
                  <p>暫無依賴數據</p>
                </div>
              ) : (
                <svg ref={svgRef} className="w-full" />
              )}
            </div>
            <p className="text-sm text-slate-600">
              提示：使用滑鼠拖拽移動圖表，滾輪縮放，點擊節點查看詳情
            </p>
          </TabsContent>

          <TabsContent value="legend" className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-3">
                <h3 className="font-semibold text-slate-900">節點類型</h3>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-cyan-500" />
                    <span className="text-sm text-slate-700">欄位 ({nodeTypeStats.field})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full bg-purple-500" />
                    <span className="text-sm text-slate-700">函數 ({nodeTypeStats.function})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-pink-500" />
                    <span className="text-sm text-slate-700">表格 ({nodeTypeStats.table})</span>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <h3 className="font-semibold text-slate-900">依賴類型</h3>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-0.5 bg-blue-500" />
                    <span className="text-sm text-slate-700">讀取 ({linkTypeStats.read})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-0.5 bg-red-500" />
                    <span className="text-sm text-slate-700">寫入 ({linkTypeStats.write})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-0.5 bg-amber-500" />
                    <span className="text-sm text-slate-700">計算 ({linkTypeStats.calculate})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-0.5 bg-purple-500" />
                    <span className="text-sm text-slate-700">呼叫 ({linkTypeStats.call})</span>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="details" className="space-y-4">
            {selectedNode ? (
              <div className="space-y-3 p-4 bg-slate-50 rounded-lg border border-slate-200">
                <h3 className="font-semibold text-slate-900">{selectedNode.name}</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-600">類型：</span>
                    <Badge variant="outline">{selectedNode.type}</Badge>
                  </div>
                  {selectedNode.language && (
                    <div className="flex justify-between">
                      <span className="text-slate-600">語言：</span>
                      <span className="text-slate-900">{selectedNode.language}</span>
                    </div>
                  )}
                  {selectedNode.file && (
                    <div className="flex justify-between">
                      <span className="text-slate-600">檔案：</span>
                      <span className="text-slate-900 truncate">{selectedNode.file}</span>
                    </div>
                  )}
                  {selectedNode.line && (
                    <div className="flex justify-between">
                      <span className="text-slate-600">行號：</span>
                      <span className="text-slate-900">{selectedNode.line}</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-slate-500 text-center py-8">點擊圖表中的節點查看詳情</p>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
