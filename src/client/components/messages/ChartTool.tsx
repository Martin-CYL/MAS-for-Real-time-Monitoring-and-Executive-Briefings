import { t, getLocale } from "../../i18n/translate"
import { useLocale } from "../../i18n/useTranslation"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChartColumn, Download, Maximize2 } from "lucide-react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, Pie, PieChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { ChartToolPayload } from "../../../shared/display-tools"
import { CHART_COLORS, resolveChartKeys } from "../../../shared/display-tools"
import { Button } from "../ui/button"
import { openViewer } from "../../stores/viewerStore"
import { ViewerIconButton, ViewerSurface } from "../viewer/ViewerSurface"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "../ui/select"
import "./chart-tool.css"

export function csvCell(value: unknown): string {
  const text = String(value ?? "")
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '\"\"')}"` : text
}

function formatChartCell(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("en-US", { maximumFractionDigits: value % 1 === 0 ? 0 : 2 })
  }
  return value ?? ""
}

type ChartConfigMap = Record<string, { label?: string; color: string }>
type AggregateMode = "avg" | "bottom_quartile" | "median" | "top_quartile" | "min" | "max" | "sum" | "count"
type ChartTableRow = {
  key: string
  color?: string
  cells: Array<string | number>
  values: Array<number | null>
}
type ChartTableData = {
  headers: string[]
  rows: ChartTableRow[]
}

const CHART_SERIES_COLORS = CHART_COLORS
const CHART_TICK_PROPS = {
  fill: "hsl(var(--muted-foreground))",
  fontSize: 12,
} as const

const AGGREGATE_OPTIONS: Array<{ value: AggregateMode; label: string }> = [
  { value: "avg", get label() { return t("Avg") } },
  { value: "bottom_quartile", get label() { return t("Bottom Quartile") } },
  { value: "median", get label() { return t("Median") } },
  { value: "top_quartile", get label() { return t("Top Quartile") } },
  { value: "min", get label() { return t("Min") } },
  { value: "max", get label() { return t("Max") } },
  { value: "sum", get label() { return t("Sum") } },
  { value: "count", get label() { return t("Count") } },
]

function percentile(sortedValues: number[], percentileValue: number) {
  if (!sortedValues.length) return 0
  if (sortedValues.length === 1) return sortedValues[0]
  const index = (sortedValues.length - 1) * percentileValue
  const lowerIndex = Math.floor(index)
  const upperIndex = Math.ceil(index)
  const weight = index - lowerIndex
  return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function shouldHideDecimalValues(data: Array<Record<string, string | number | null>>, numericKeys: string[]): boolean {
  const values = data.flatMap((row) => (
    numericKeys
      .map((key) => row[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value !== 0)
      .map((value) => Math.abs(value))
  ))
  const medianValue = median(values)
  return medianValue !== null && medianValue >= 1_000
}

function formatCompact(value: number, hideDecimals = false): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(hideDecimals || abs >= 10_000_000_000 ? 0 : 1)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(hideDecimals || abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(hideDecimals || abs >= 10_000 ? 0 : 1)}K`
  if (hideDecimals) return Math.round(value).toLocaleString(getLocale())
  return value % 1 === 0 ? String(value) : value.toFixed(1)
}

function estimateYAxisWidth(data: Array<Record<string, string | number | null>>, dataKeys: string[], hideDecimals = false): number {
  let maxLen = 1
  for (const row of data) {
    for (const key of dataKeys) {
      const value = row[key]
      if (typeof value !== "number") continue
      maxLen = Math.max(maxLen, formatCompact(value, hideDecimals).length)
    }
  }
  return Math.max(32, maxLen * 8 + 16)
}

function aggregateValues(values: Array<number | null>, mode: AggregateMode): number | string {
  const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  if (!numeric.length) return ""
  const rounded = (value: number) => Number(value.toFixed(2))
  switch (mode) {
    case "count":
      return numeric.length
    case "sum":
      return rounded(numeric.reduce((sum, value) => sum + value, 0))
    case "min":
      return rounded(Math.min(...numeric))
    case "max":
      return rounded(Math.max(...numeric))
    case "bottom_quartile":
    case "median":
    case "top_quartile": {
      const sorted = [...numeric].sort((a, b) => a - b)
      if (mode === "bottom_quartile") return rounded(percentile(sorted, 0.25))
      if (mode === "top_quartile") return rounded(percentile(sorted, 0.75))
      return rounded(percentile(sorted, 0.5))
    }
    case "avg":
      return rounded(numeric.reduce((sum, value) => sum + value, 0) / numeric.length)
  }
}

function toNumericValue(value: string | number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function ChartTooltipContent({
  active,
  payload,
  label,
  config,
}: {
  active?: boolean
  payload?: Array<{ dataKey?: string | number; value?: string | number; color?: string; name?: string }>
  label?: string | number
  config: ChartConfigMap
}) {
  useLocale()
  if (!active || !payload?.length) return null
  const entries = payload.filter((item) => item.value !== undefined && item.value !== null)
  if (!entries.length) return null

  return (
    <div className="chart-tooltip">
      {label !== undefined ? <div className="chart-tooltip-label">{label}</div> : null}
      <div className="chart-tooltip-list">
        {entries.map((item, index) => {
          const key = String(item.dataKey ?? item.name ?? index)
          const itemConfig = config[key]
          return (
            <div className="chart-tooltip-row" key={`${key}-${index}`}>
              <span className="chart-tooltip-name">
                <i style={{ backgroundColor: itemConfig?.color || item.color }} />
                {itemConfig?.label || item.name || key}
              </span>
              <span className="chart-tooltip-value">{formatChartCell(item.value)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AggregateMenu({ value, onChange }: {
  value: AggregateMode
  onChange: (value: AggregateMode) => void
  align?: "start" | "end"
}) {
  useLocale()
  return (
    <Select value={value} onValueChange={(next) => onChange(next as AggregateMode)}>
      <SelectTrigger aria-label={t("Aggregation")} className="h-7 w-auto"><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup>
        {AGGREGATE_OPTIONS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
      </SelectGroup></SelectContent>
    </Select>
  )
}

function ChartDataTable({
  table,
  rowAggregateMode,
  columnAggregateMode,
  hiddenKeys,
  onRowAggregateModeChange,
  onColumnAggregateModeChange,
  onToggleKey,
  onHoverKey,
}: {
  table: ChartTableData
  rowAggregateMode: AggregateMode
  columnAggregateMode: AggregateMode
  hiddenKeys: ReadonlySet<string>
  onRowAggregateModeChange: (value: AggregateMode) => void
  onColumnAggregateModeChange: (value: AggregateMode) => void
  onToggleKey: (key: string) => void
  onHoverKey: (key: string | null) => void
}) {
  useLocale()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [firstColumnWidth, setFirstColumnWidth] = useState(176)
  const [scrollViewportWidth, setScrollViewportWidth] = useState(0)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    element.scrollLeft = element.scrollWidth
  }, [table])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const updateWidth = () => setScrollViewportWidth(element.clientWidth)
    updateWidth()
    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(element)
    return () => resizeObserver.disconnect()
  }, [])

  if (!table.headers.length || !table.rows.length) return null

  function startFirstColumnResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = firstColumnWidth
    function handlePointerMove(moveEvent: PointerEvent) {
      setFirstColumnWidth(Math.min(360, Math.max(128, startWidth + moveEvent.clientX - startX)))
    }
    function handlePointerUp() {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("pointerup", handlePointerUp)
    }
    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("pointerup", handlePointerUp)
  }

  const aggregateCells = table.headers.slice(1).map((_, valueIndex) => aggregateValues(table.rows.map((row) => row.values[valueIndex] ?? null), columnAggregateMode))
  const firstColumnStyle = { width: firstColumnWidth, minWidth: firstColumnWidth, maxWidth: firstColumnWidth }
  const valueColumnWidth = Math.max(124, Math.floor(Math.max(0, scrollViewportWidth - firstColumnWidth) / Math.max(1, table.headers.length)))
  const valueColumnStyle = { width: valueColumnWidth, minWidth: valueColumnWidth, maxWidth: valueColumnWidth }

  return (
    <div className="chart-data-table">
      <div className="chart-data-scroll" ref={scrollRef}>
        <div className="chart-data-inner">
          <div className="chart-data-series" style={firstColumnStyle}>
            <table style={firstColumnStyle}>
              <thead>
                <tr><th style={firstColumnStyle}>{table.headers[0]}</th></tr>
              </thead>
              <tbody>
                {table.rows.map((row) => {
                  const hidden = hiddenKeys.has(row.key)
                  return (
                    <tr key={row.key}>
                      <td style={firstColumnStyle}>
                        <button
                          type="button"
                          aria-pressed={!hidden}
                          onClick={() => onToggleKey(row.key)}
                          onMouseEnter={() => onHoverKey(row.key)}
                          onMouseLeave={() => onHoverKey(null)}
                          className={hidden ? "muted" : ""}
                        >
                          {row.color ? <i style={{ backgroundColor: row.color, opacity: hidden ? 0.45 : 1 }} /> : null}
                          <span title={String(row.cells[0])}>{row.cells[0]}</span>
                        </button>
                      </td>
                    </tr>
                  )
                })}
                <tr>
                  <td className="chart-series-aggregate-cell" style={firstColumnStyle}>
                    <AggregateMenu value={columnAggregateMode} onChange={onColumnAggregateModeChange} align="start" />
                  </td>
                </tr>
              </tbody>
            </table>
            <div
              className="chart-column-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("Resize first column")}
              onPointerDown={startFirstColumnResize}
            />
          </div>
          <table className="chart-data-values">
            <thead>
              <tr>
                {table.headers.slice(1).map((header, index) => (
                  <th key={`${header}-${index}`} style={valueColumnStyle}>{header}</th>
                ))}
                <th className="chart-aggregate-column" style={valueColumnStyle}>
                  <AggregateMenu value={rowAggregateMode} onChange={onRowAggregateModeChange} />
                </th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.key}>
                  {row.cells.slice(1).map((cell, index) => (
                    <td key={`${row.key}-${index}`} style={valueColumnStyle}><span>{formatChartCell(cell)}</span></td>
                  ))}
                  <td className="chart-aggregate-column" style={valueColumnStyle}><span>{formatChartCell(aggregateValues(row.values, rowAggregateMode))}</span></td>
                </tr>
              ))}
              <tr>
                {aggregateCells.map((cell, index) => (
                  <td className="chart-aggregate-row" key={`aggregate-${index}`} style={valueColumnStyle}><span>{formatChartCell(cell)}</span></td>
                ))}
                <td className="chart-aggregate-row chart-aggregate-column" style={valueColumnStyle} aria-hidden="true" />
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/**
 * Everything a chart view needs from its payload: series, colors, the data
 * table, legend state and CSV downloads. The inline card and the viewer's
 * full-size chart each hold their own (hiding a series in one doesn't hide it
 * in the other), but they draw from this one definition.
 */
function useChartModel(payload: ChartToolPayload) {
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set())
  const [activeLegendKey, setActiveLegendKey] = useState<string | null>(null)
  const [rowAggregateMode, setRowAggregateMode] = useState<AggregateMode>("avg")
  const [columnAggregateMode, setColumnAggregateMode] = useState<AggregateMode>("avg")
  const data = payload.data ?? []
  const firstRow = data[0] ?? {}
  const { xKey, keys } = resolveChartKeys(payload)
  const config = Object.fromEntries(keys.map((key, index) => [key, { label: payload.config?.[key]?.label ?? key, color: payload.config?.[key]?.color ?? CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length] }])) as ChartConfigMap
  const hideDecimalValues = useMemo(() => shouldHideDecimalValues(data, keys), [data, keys, getLocale()])
  const formatAxisValue = useCallback((value: number) => formatCompact(value, hideDecimalValues), [hideDecimalValues])
  const yAxisWidth = useMemo(() => estimateYAxisWidth(data, keys, hideDecimalValues), [data, hideDecimalValues, keys, getLocale()])
  const csvKeys = [...new Set(data.flatMap(row => Object.keys(row)))]
  const csv = [csvKeys, ...data.map(row => csvKeys.map(key => row[key] ?? ""))].map(row => row.map(csvCell).join(",")).join("\n")
  const chartTable = useMemo<ChartTableData>(() => {
    if (payload.type === "pie") {
      const valueKey = keys[0] ?? Object.keys(firstRow).find((key) => typeof firstRow[key] === "number") ?? "value"
      return {
        headers: ["Series", "Value"],
        rows: data.map((row, index) => ({
          key: String(row[xKey] ?? t("Segment {0}", { 0: index + 1 })),
          color: CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length],
          cells: [String(row[xKey] ?? t("Segment {0}", { 0: index + 1 })), formatChartCell(row[valueKey])],
          values: [toNumericValue(row[valueKey])],
        })),
      }
    }
    return {
      headers: ["Series", ...data.map((row, index) => String(row[xKey] ?? t("Point {0}", { 0: index + 1 })))],
      rows: keys.map((key) => {
        const values = data.map((row) => row[key])
        return {
          key,
          color: config[key].color,
          cells: [
            config[key].label ?? key,
            ...values.map(formatChartCell),
          ],
          values: values.map(toNumericValue),
        }
      }),
    }
  }, [config, data, firstRow, keys, payload.type, xKey, getLocale()])

  function toggleLegendKey(key: string) {
    setHiddenKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function shouldMuteSeries(key: string) {
    return Boolean(activeLegendKey && activeLegendKey !== key)
  }

  function downloadCsv() {
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${(payload.title || "chart").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function downloadTableCsv() {
    const rows = [
      chartTable.headers,
      ...chartTable.rows.map((row) => row.cells),
    ]
    const blob = new Blob([rows.map((row) => row.map((value) => {
      const text = String(value ?? "")
      return text.includes(",") || text.includes("\"") || text.includes("\n")
        ? `"${text.replace(/"/g, "\"\"")}"`
        : text
    }).join(",")).join("\n")], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${(payload.title || "chart").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "chart"}_table.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const axisProps = {
    tickLine: false,
    axisLine: false,
    tickMargin: 8,
    tick: CHART_TICK_PROPS,
  } as const
  const tooltip = <Tooltip cursor={payload.type === "bar" ? { fill: "hsl(var(--foreground) / 0.06)", stroke: "none" } : { stroke: "hsl(var(--muted-foreground) / 0.5)", strokeWidth: 1 }} content={<ChartTooltipContent config={payload.type === "pie" ? {} : config} />} isAnimationActive={false} animationDuration={0} />
  const renderChart = () => (
    <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 400 }}>
      {payload.type === "line" ? (
        <LineChart data={data} margin={{ top: 12, right: 12, left: 12, bottom: 0 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" /><XAxis dataKey={xKey} {...axisProps} /><YAxis {...axisProps} width={yAxisWidth} tickFormatter={(value) => formatAxisValue(Number(value))} />{tooltip}{keys.map((key) => <Line key={key} type="monotone" dataKey={key} stroke={config[key].color} strokeWidth={2} strokeOpacity={shouldMuteSeries(key) ? 0.18 : 1} dot={false} activeDot={{ fill: config[key].color, stroke: "hsl(var(--card))", strokeWidth: 2, r: 4 }} hide={hiddenKeys.has(key)} isAnimationActive={false} />)}</LineChart>
      ) : payload.type === "area" ? (
        <AreaChart data={data} margin={{ top: 12, right: 12, left: 12, bottom: 0 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" /><XAxis dataKey={xKey} {...axisProps} /><YAxis {...axisProps} width={yAxisWidth} tickFormatter={(value) => formatAxisValue(Number(value))} />{tooltip}{keys.map((key) => <Area key={key} type="monotone" dataKey={key} fill={config[key].color} fillOpacity={shouldMuteSeries(key) ? 0.08 : 0.25} stroke={config[key].color} strokeWidth={shouldMuteSeries(key) ? 0 : 2} activeDot={{ fill: config[key].color, stroke: "hsl(var(--card))", strokeWidth: 2, r: 4 }} stackId={payload.stacked ? "stack" : undefined} hide={hiddenKeys.has(key)} isAnimationActive={false} />)}</AreaChart>
      ) : payload.type === "pie" ? (
        <PieChart margin={{ top: 12, right: 12, left: 12, bottom: 12 }}>{tooltip}<Pie data={data} dataKey={keys[0]} nameKey={xKey} innerRadius="45%" outerRadius="75%" stroke="none" isAnimationActive={false}>{data.map((row, index) => <Cell key={index} fill={CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]} opacity={hiddenKeys.has(String(row[xKey] ?? t("Segment {0}", { 0: index + 1 }))) ? 0.18 : 1} />)}</Pie></PieChart>
      ) : (
        <BarChart data={data} margin={{ top: 12, right: 12, left: 12, bottom: 0 }}><CartesianGrid vertical={false} stroke="hsl(var(--border))" /><XAxis dataKey={xKey} {...axisProps} /><YAxis {...axisProps} width={yAxisWidth} tickFormatter={(value) => formatAxisValue(Number(value))} />{tooltip}{keys.map((key) => <Bar key={key} dataKey={key} fill={config[key].color} fillOpacity={shouldMuteSeries(key) ? 0.18 : 1} radius={payload.stacked ? 0 : 4} stackId={payload.stacked ? "stack" : undefined} hide={hiddenKeys.has(key)} isAnimationActive={false} />)}</BarChart>
      )}
    </ResponsiveContainer>
  )
  const legendItems = payload.type === "pie"
    ? chartTable.rows.map(row => ({ key: row.key, label: String(row.cells[0]), color: row.color }))
    : keys.map(key => ({ key, label: config[key].label, color: config[key].color }))
  const chartFigure = (className = "") => (
    <div className={className}>
      <div className="chart-render-area">{data.length ? renderChart() : <div className="chart-empty">{t("Generating chart...")}</div>}</div>
      {keys.length > 0 ? (
        <div className="chart-legend">
          {legendItems.map(({ key, label, color }) => (
            <button
              key={key}
              type="button"
              aria-pressed={!hiddenKeys.has(key)}
              className={hiddenKeys.has(key) ? "muted" : ""}
              onClick={() => toggleLegendKey(key)}
              onMouseEnter={() => setActiveLegendKey(key)}
              onMouseLeave={() => setActiveLegendKey(null)}
            >
              <i style={{ backgroundColor: color, opacity: hiddenKeys.has(key) ? 0.45 : 1 }} />
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )

  return {
    keys,
    chartTable,
    chartFigure,
    downloadCsv,
    downloadTableCsv,
    hiddenKeys,
    toggleLegendKey,
    setActiveLegendKey,
    rowAggregateMode,
    setRowAggregateMode,
    columnAggregateMode,
    setColumnAggregateMode,
  }
}

export function ChartTool({ payload }: { payload: ChartToolPayload }) {
  useLocale()
  const { chartFigure, downloadCsv } = useChartModel(payload)
  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <div>
          <h3>{payload.title}</h3>
          {payload.description ? <p>{payload.description}</p> : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            onClick={downloadCsv}
            title={t("Download CSV")}
            className="text-muted-foreground hover:text-muted-foreground"
          >
            <Download size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            // Full size opens in the viewer, the same surface as a diff or an
            // attachment, rather than a modal of the chart's own.
            onClick={() => openViewer({ kind: "chart", payload })}
            title={t("Expand chart")}
            className="text-muted-foreground hover:text-muted-foreground"
          >
            <Maximize2 size={14} />
          </Button>
        </div>
      </div>
      {chartFigure("chart-body")}
    </div>
  )
}

/** A chart at full size in the viewer: the chart, its legend, and the data table under it. */
export function ChartFullView({ payload, onClose }: { payload: ChartToolPayload; onClose: () => void }) {
  useLocale()
  const model = useChartModel(payload)
  return (
    <ViewerSurface
      label={t("Chart: {0}", { 0: payload.title || t("Chart") })}
      icon={<ChartColumn />}
      title={payload.title || t("Chart")}
      subtitle={payload.description}
      onClose={onClose}
      toolbar={<ViewerIconButton label={t("Download table as CSV")} onClick={model.downloadTableCsv}><Download /></ViewerIconButton>}
    >
      <div className="flex min-h-full flex-col gap-4 p-4">
        {/* Full width, but not full proportion: at the inline card's 3:2 a
            wide viewer makes the chart ~800px tall and pushes its table off
            screen. The cap keeps both in view; the chart widens, not grows. */}
        {model.chartFigure("flex shrink-0 flex-col text-xs text-muted-foreground [&_.chart-render-area]:max-h-[min(55vh,460px)] [&_.recharts-text]:fill-muted-foreground [&_.recharts-text]:text-xs")}
        <ChartDataTable
          table={model.chartTable}
          rowAggregateMode={model.rowAggregateMode}
          columnAggregateMode={model.columnAggregateMode}
          hiddenKeys={model.hiddenKeys}
          onRowAggregateModeChange={model.setRowAggregateMode}
          onColumnAggregateModeChange={model.setColumnAggregateMode}
          onToggleKey={model.toggleLegendKey}
          onHoverKey={model.setActiveLegendKey}
        />
      </div>
    </ViewerSurface>
  )
}
