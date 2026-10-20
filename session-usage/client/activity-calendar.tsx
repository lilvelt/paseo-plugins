import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { calendarActivity, calendarPeriod, toggleCalendarDay } from "../shared/calendar";
import { dateRange, filterSessions, formatMetric, isDayString, METRICS, type DisplayMetric, type Filters } from "../shared/model";
import type { Session } from "../shared/schema";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const tintOpacity = (intensity: number) => intensity > 0 ? 0.16 + 0.84 * intensity : 0;

export function ActivityCalendar({ sessions, filters, onChange, metric, average, theme, compact }: {
  sessions: Session[]; filters: Filters; onChange(filters: Filters): void;
  metric: DisplayMetric; average: boolean; theme: PluginTheme; compact: boolean;
}) {
  const [width, setWidth] = useState(0);
  const monthly = compact || (width > 0 && width < 760);
  const [monthOffset, setMonthOffset] = useState(0);
  const [yearOffset, setYearOffset] = useState(0);
  const offset = monthly ? monthOffset : yearOffset;
  const setOffset = monthly ? setMonthOffset : setYearOffset;
  const [inspected, setInspected] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const period = useMemo(() => calendarPeriod(today, monthly, offset), [today, monthly, offset]);
  const activity = useMemo(() => calendarActivity(sessions, filters, metric, average, period.from, period.to > today ? today : period.to), [sessions, filters, metric, average, period.from, period.to, today]);
  // Do not silently call an Antigravity observation date an execution date.
  // The note respects current non-date filters, like the calendar itself.
  const hasObservedDate = filterSessions(sessions, {
    ...filters, period: "all", from: "", to: "",
  }).some((row) => row.buckets.some((bucket) => bucket.dateBasis === "observed"));
  const selectedRange = dateRange(filters);
  const selectedDay = !selectedRange.error && isDayString(selectedRange.from) && selectedRange.from === selectedRange.to ? selectedRange.from : null;
  const detailDay = inspected ?? (selectedDay && selectedDay >= period.from && selectedDay <= period.to ? selectedDay : null);
  const lifetime = metric === "durationMs" || metric === "bytes";
  const text = { color: theme.colors.foreground, fontSize: 13 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const button = { minHeight: 36, paddingHorizontal: 10, justifyContent: "center" as const, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6 };
  const cellHeight = 0.8 * (monthly ? 44 : Math.min(24, Math.max(12, ((width || 950) - (compact ? 26 : 34) - 30 - 3 * period.weeks.length) / period.weeks.length)));
  const heading = monthly ? new Date(period.from).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }) : `${period.from} – ${period.to}`;
  function describe(day: string): string {
    if (day > today) return `${day} · Future date`;
    const result = activity.days.get(day);
    if (!result) return `${day} · No recorded activity`;
    if (lifetime) return `${day} · ${result.total} sessions · This metric covers the full session`;
    return `${day} · ${formatMetric(metric, result.value)} ${METRICS[metric].label.toLocaleLowerCase()} · ${result.known}/${result.total} sessions known`;
  }
  function renderDay(day: string) {
    if (day < period.from || day > period.to) return <View key={day} style={{ height: cellHeight, flex: monthly ? 1 : undefined }} />;
    const result = activity.days.get(day);
    const future = day > today;
    const unknown = Boolean(result && result.value === null);
    return <Pressable key={day} testID={`activity-day-${day}`} accessibilityRole="button" accessibilityLabel={describe(day)} accessibilityHint={selectedDay === day ? "Clear the report's date filter" : "Filter the report to this UTC day"} aria-selected={selectedDay === day} aria-disabled={future} disabled={future}
      onPress={() => onChange(toggleCalendarDay(filters, day))} onHoverIn={() => setInspected(day)} onHoverOut={() => setInspected(null)} onFocus={() => setInspected(day)} onBlur={() => setInspected(null)}
      style={{ height: cellHeight, flex: monthly ? 1 : undefined, borderRadius: monthly ? 6 : 3, overflow: "hidden", justifyContent: "center", alignItems: "center", borderWidth: selectedDay === day ? 2 : 1, borderStyle: unknown && selectedDay !== day ? "dashed" : "solid", borderColor: selectedDay === day ? theme.colors.foreground : theme.colors.border, backgroundColor: theme.colors.surface2, opacity: future ? 0.35 : 1 }}>
      <View pointerEvents="none" testID={`activity-tint-${day}`} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: theme.colors.accent, opacity: tintOpacity(result?.intensity ?? 0) }} />
      {monthly ? <Text style={{ ...text, fontSize: 12, minWidth: 22, textAlign: "center", paddingHorizontal: 3, paddingVertical: 1, borderRadius: 4, backgroundColor: theme.colors.surface1, fontWeight: selectedDay === day ? "700" : "400" }}>{Number(day.slice(-2))}</Text> : null}
    </Pressable>;
  }
  return <View testID="activity-calendar" onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: compact ? 12 : 16, gap: 12, backgroundColor: theme.colors.surface1 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={{ ...text, fontSize: 16, fontWeight: "600" }}>Daily activity</Text>
        <Text style={muted}>{METRICS[metric].label} · {average ? "Per known session" : "Daily totals"} · UTC</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Previous ${monthly ? "month" : "year"}`} onPress={() => { setOffset(offset - 1); setInspected(null); }} style={button}><Text style={text}>‹</Text></Pressable>
        <Text testID="activity-period" style={{ ...text, fontWeight: "600", fontSize: monthly ? 13 : 12 }}>{heading}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Next ${monthly ? "month" : "year"}`} disabled={offset >= 0} accessibilityState={{ disabled: offset >= 0 }} onPress={() => { setOffset(Math.min(0, offset + 1)); setInspected(null); }} style={[button, { opacity: offset >= 0 ? 0.4 : 1 }]}><Text style={text}>›</Text></Pressable>
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
      <Text style={muted}>Choose a day to filter the report; choose it again to clear. This calendar follows all filters except dates.</Text>
      {offset !== 0 ? <Pressable accessibilityRole="button" onPress={() => { setOffset(0); setInspected(null); }} style={{ minHeight: 36, justifyContent: "center" }}><Text style={{ ...text, color: theme.colors.accent }}>{monthly ? "Current month" : "Last 12 months"}</Text></Pressable> : null}
      {filters.period !== "all" ? <Pressable accessibilityRole="button" onPress={() => onChange({ ...filters, period: "all", from: "", to: "" })} style={{ minHeight: 36, justifyContent: "center" }}><Text style={{ ...text, color: theme.colors.accent }}>Clear date filter</Text></Pressable> : null}
    </View>
    {hasObservedDate ? <Text testID="activity-observation-note" style={muted}>Antigravity: observation dates use the Plugin's UTC capture time, NOT a provider-reported execution time. Missing turns are not reconstructed.</Text> : null}
    {lifetime ? <Text style={muted}>Session span and transcript size cannot be split by day. Choose another metric above to color the calendar.</Text> : null}
    {monthly ? <View testID="activity-month-grid" style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 6 }}>{WEEKDAYS.map((day) => <Text key={day} style={{ ...muted, flex: 1, textAlign: "center" }}>{day}</Text>)}</View>
      {period.weeks.map((week) => <View key={week[0]} style={{ flexDirection: "row", gap: 6 }}>{week.map(renderDay)}</View>)}
    </View> : <View testID="activity-year-grid" style={{ flexDirection: "row", gap: 3 }}>
      <View style={{ width: 30, gap: 3 }}><View style={{ height: 18 }} />{WEEKDAYS.map((day) => <View key={day} style={{ height: cellHeight, justifyContent: "center" }}><Text style={{ ...muted, fontSize: 10 }}>{day}</Text></View>)}</View>
      {period.weeks.map((week, index) => {
        const labelDay = week.find((day) => day >= period.from && day <= period.to && (index === 0 || day.endsWith("-01")));
        return <View key={week[0]} style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={{ height: 18 }}>{labelDay ? <Text numberOfLines={1} style={{ ...muted, position: "absolute", width: Math.min(55, (period.weeks.length - index) * (cellHeight + 3)), fontSize: 10 }}>{new Date(labelDay).toLocaleDateString(undefined, { month: "short", timeZone: "UTC" })}</Text> : null}</View>
          {week.map(renderDay)}
        </View>;
      })}
    </View>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <Text testID="activity-day-detail" style={[muted, { flexShrink: 1 }]}>{detailDay ? describe(detailDay) : selectedDay ? `Report filtered to ${selectedDay}` : "Select a day for details."}</Text>
      <View accessible accessibilityLabel={`Color scale from zero to ${formatMetric(metric, activity.max)} ${METRICS[metric].label}`} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Text style={muted}>Less</Text>
        {[0, 0.25, 0.5, 0.75, 1].map((intensity) => <View key={intensity} style={{ width: 12, height: 12, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}><View style={{ flex: 1, backgroundColor: theme.colors.accent, opacity: tintOpacity(intensity) }} /></View>)}
        <Text style={muted}>More · {formatMetric(metric, activity.max, true)}</Text>
      </View>
    </View>
    <Text style={muted}>Color uses one scale across the visible {monthly ? "month" : "year"}. Empty cells mean no recorded activity or zero; dashed cells mean the metric is unknown.</Text>
  </View>;
}
