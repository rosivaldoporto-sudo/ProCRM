"use client";

import { useId } from "react";
import { AlertTriangle, Clock3, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LeadFormScheduling } from "@/lib/lead-forms/types";
import { isValidTimeZone } from "@/lib/lead-forms/timezone";

const DOWS = [
  ["mon", "Seg"],
  ["tue", "Ter"],
  ["wed", "Qua"],
  ["thu", "Qui"],
  ["fri", "Sex"],
  ["sat", "Sáb"],
  ["sun", "Dom"],
] as const;

const TIMEZONES = [
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Rio_Branco",
  "America/Belem",
  "America/Fortaleza",
  "America/Recife",
  "America/Cuiaba",
  "America/Porto_Velho",
  "America/Boa_Vista",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Mexico_City",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "Europe/Lisbon",
  "Europe/London",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Africa/Luanda",
  "Africa/Maputo",
  "UTC",
];

type TimeWindow = [string, string];

interface Props {
  value: LeadFormScheduling;
  onChange: (value: LeadFormScheduling) => void;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatMinutes(minutes: number): string {
  if (minutes <= 0) return "0 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${pad2(rest)}` : `${hours}h`;
}

function NumberField({
  label,
  value,
  min,
  max,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          onChange(Number.isFinite(next) ? next : min);
        }}
        onBlur={(event) => onChange(clampInt(Number(event.target.value), min, max))}
      />
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

function WindowsEditor({
  windows,
  onChange,
}: {
  windows: TimeWindow[];
  onChange: (windows: TimeWindow[]) => void;
}) {
  function updateWindow(index: number, part: 0 | 1, next: string) {
    const copy = windows.map((window) => [...window] as TimeWindow);
    copy[index][part] = next;
    onChange(copy);
  }

  return (
    <div className="space-y-2">
      {windows.length === 0 && (
        <p className="text-xs text-muted-foreground">Indisponível neste dia.</p>
      )}
      {windows.map(([start, end], index) => {
        const invalid = !start || !end || end <= start;
        return (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Input
              type="time"
              value={start}
              aria-label="Início"
              aria-invalid={invalid}
              className="w-[118px]"
              onChange={(event) => updateWindow(index, 0, event.target.value)}
            />
            <span className="text-xs text-muted-foreground">até</span>
            <Input
              type="time"
              value={end}
              aria-label="Fim"
              aria-invalid={invalid}
              className="w-[118px]"
              onChange={(event) => updateWindow(index, 1, event.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remover horário"
              onClick={() => onChange(windows.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            {invalid && (
              <span className="text-[11px] text-destructive">
                O fim precisa ser maior que o início.
              </span>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...windows, ["09:00", "18:00"]])}
      >
        <Plus className="h-3.5 w-3.5" /> Adicionar horário
      </Button>
    </div>
  );
}

export function ScheduleEditor({ value, onChange }: Props) {
  const tzInputId = useId();
  const tzListId = useId();
  const availability = value.availability ?? {};
  const overrides = value.date_overrides ?? {};
  const tzOk = isValidTimeZone(value.timezone);

  let invalidWindows = 0;
  for (const [key] of DOWS) {
    for (const [start, end] of availability[key] ?? []) {
      if (!start || !end || end <= start) invalidWindows += 1;
    }
  }
  for (const windows of Object.values(overrides)) {
    for (const [start, end] of windows) {
      if (!start || !end || end <= start) invalidWindows += 1;
    }
  }

  const hasAvailability =
    DOWS.some(([key]) => (availability[key] ?? []).length > 0) ||
    Object.values(overrides).some((windows) => windows.length > 0);

  function update(patch: Partial<LeadFormScheduling>) {
    onChange({ ...value, ...patch });
  }

  function setDayWindows(key: string, windows: TimeWindow[]) {
    update({ availability: { ...availability, [key]: windows } });
  }

  function setOverride(dayKey: string, windows: TimeWindow[]) {
    update({ date_overrides: { ...overrides, [dayKey]: windows } });
  }

  function removeOverride(dayKey: string) {
    const next = { ...overrides };
    delete next[dayKey];
    update({ date_overrides: next });
  }

  function renameOverride(oldDayKey: string, newDayKey: string) {
    if (!newDayKey || newDayKey === oldDayKey) return;
    const next = { ...overrides };
    next[newDayKey] = next[oldDayKey] ?? [];
    delete next[oldDayKey];
    update({ date_overrides: next });
  }

  function addOverride() {
    const used = new Set(Object.keys(overrides));
    const base = new Date();
    base.setHours(12, 0, 0, 0);
    for (let offset = 1; offset <= 365; offset += 1) {
      const date = new Date(base);
      date.setDate(base.getDate() + offset);
      const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
      if (!used.has(key)) {
        setOverride(key, []);
        return;
      }
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>Agendamento de reunião</CardTitle>
          <CardDescription>
            Qualificados veem os horários livres e agendam direto no formulário.
            As regras abaixo são aplicadas no servidor, no fuso escolhido.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={value.enabled}
              onCheckedChange={(enabled) => update({ enabled })}
            />
            Ativar agendamento para qualificados
          </label>

          {!tzOk && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Fuso inválido. Use um nome IANA, como America/Sao_Paulo.
            </div>
          )}
          {invalidWindows > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {invalidWindows} horário(s) com fim menor ou igual ao início. Corrija para não perder a regra ao salvar.
            </div>
          )}
          {value.enabled && !hasAvailability && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Nenhum horário disponível. A agenda não exibirá opções de agendamento.
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField
              label="Duração (min)"
              value={value.duration_min}
              min={5}
              max={480}
              hint="Tempo da reunião."
              onChange={(duration_min) =>
                update({
                  duration_min,
                  slot_interval_min: Math.max(value.slot_interval_min, duration_min),
                })
              }
            />
            <NumberField
              label="Intervalo (min)"
              value={value.slot_interval_min}
              min={value.duration_min}
              max={480}
              hint="De quanto em quanto tempo os horários aparecem."
              onChange={(slot_interval_min) => update({ slot_interval_min })}
            />
            <NumberField
              label="Antecedência (min)"
              value={value.min_notice_min}
              min={0}
              max={10_080}
              hint="Tempo mínimo entre agora e o primeiro horário."
              onChange={(min_notice_min) => update({ min_notice_min })}
            />
            <NumberField
              label="Agenda aberta por (dias)"
              value={value.max_days_ahead}
              min={1}
              max={365}
              hint="Inclui hoje. Ex.: 60 mostra os próximos 60 dias."
              onChange={(max_days_ahead) => update({ max_days_ahead })}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField
              label="Buffer antes (min)"
              value={value.buffer_before_min}
              min={0}
              max={240}
              hint="Espaço livre antes da reunião."
              onChange={(buffer_before_min) => update({ buffer_before_min })}
            />
            <NumberField
              label="Buffer depois (min)"
              value={value.buffer_after_min}
              min={0}
              max={240}
              hint="Espaço livre depois da reunião."
              onChange={(buffer_after_min) => update({ buffer_after_min })}
            />
            <div className="space-y-1">
              <Label>Limite por dia</Label>
              <Input
                type="number"
                min={1}
                max={1000}
                value={value.max_bookings_per_day ?? ""}
                placeholder="Ilimitado"
                onChange={(event) => {
                  const raw = event.target.value;
                  if (raw === "") {
                    update({ max_bookings_per_day: null });
                    return;
                  }
                  const next = Number(raw);
                  if (Number.isFinite(next)) {
                    update({ max_bookings_per_day: next });
                  }
                }}
                onBlur={(event) => {
                  const raw = event.target.value;
                  update({
                    max_bookings_per_day:
                      raw === "" ? null : clampInt(Number(raw), 1, 1000),
                  });
                }}
              />
              <p className="text-[11px] leading-snug text-muted-foreground">
                Deixe vazio para não limitar.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor={tzInputId}>Fuso da agenda</Label>
              <Input
                id={tzInputId}
                list={tzListId}
                value={value.timezone}
                aria-invalid={!tzOk}
                onChange={(event) => update({ timezone: event.target.value })}
                placeholder="America/Sao_Paulo"
              />
              <datalist id={tzListId}>
                {TIMEZONES.map((timeZone) => (
                  <option key={timeZone} value={timeZone} />
                ))}
              </datalist>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Horários exibidos neste fuso, inclusive com horário de verão.
              </p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Responsável</Label>
              <Input
                value={value.owner_name ?? ""}
                onChange={(event) => update({ owner_name: event.target.value || null })}
                placeholder="Ex: Ana (SDR)"
              />
            </div>
            <div className="space-y-1">
              <Label>Título da reunião</Label>
              <Input
                value={value.meeting_title}
                onChange={(event) => update({ meeting_title: event.target.value })}
              />
            </div>
          </div>

          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <p className="flex items-center gap-1.5 font-medium text-foreground">
              <Clock3 className="h-3.5 w-3.5" />
              {value.duration_min} min · a cada {value.slot_interval_min} min
            </p>
            <p className="mt-1">
              Agenda aberta por {value.max_days_ahead} dias
              {" · "}
              {value.min_notice_min > 0
                ? `${formatMinutes(value.min_notice_min)} de antecedência`
                : "sem antecedência mínima"}
              {" · "}
              {value.buffer_before_min === 0 && value.buffer_after_min === 0
                ? "sem buffers"
                : `buffer de ${value.buffer_before_min} min antes e ${value.buffer_after_min} min depois`}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Grade semanal</CardTitle>
          <CardDescription>
            Vários intervalos por dia são permitidos. Ex.: 09:00–12:00 e 13:00–18:00.
            Intervalos sobrepostos são unidos ao salvar.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {DOWS.map(([key, label]) => {
              const windows = availability[key] ?? [];
              return (
                <div key={key} className="flex flex-col gap-2 px-4 py-3 sm:flex-row">
                  <span className="w-14 shrink-0 text-sm font-medium sm:pt-1">
                    {label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <WindowsEditor
                      windows={windows}
                      onChange={(next) => setDayWindows(key, next)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exceções por data</CardTitle>
          <CardDescription>
            Feriados, férias ou horários diferentes em um dia específico. A data é
            interpretada no fuso da agenda e substitui a grade semanal. Sem horários
            significa dia bloqueado.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {Object.keys(overrides).length === 0 && (
            <p className="text-xs text-muted-foreground">Nenhuma exceção cadastrada.</p>
          )}
          {Object.entries(overrides)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([dayKey, windows]) => (
              <div key={dayKey} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label>Data</Label>
                    <Input
                      type="date"
                      value={dayKey}
                      className="w-[150px]"
                      onChange={(event) => renameOverride(dayKey, event.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Disponibilidade</Label>
                    <Select
                      value={windows.length > 0 ? "custom" : "blocked"}
                      onValueChange={(mode) =>
                        setOverride(
                          dayKey,
                          mode === "blocked" ? [] : [["09:00", "18:00"]],
                        )
                      }
                    >
                      <SelectTrigger className="w-[190px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="blocked">Dia indisponível</SelectItem>
                        <SelectItem value="custom">Horário personalizado</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remover exceção"
                    className="ml-auto"
                    onClick={() => removeOverride(dayKey)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {windows.length > 0 ? (
                  <WindowsEditor
                    windows={windows}
                    onChange={(next) => setOverride(dayKey, next)}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Dia bloqueado para agendamentos.
                  </p>
                )}
              </div>
            ))}
          <Button type="button" variant="outline" size="sm" onClick={addOverride}>
            <Plus className="h-3.5 w-3.5" /> Adicionar exceção
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
