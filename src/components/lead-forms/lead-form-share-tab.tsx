"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface Props {
  slug: string;
  onSlugChange: (slug: string) => void;
  publicUrl: string;
}

type PresetId = "meta" | "google" | "tiktok" | "manual";

interface Preset {
  id: PresetId;
  label: string;
  hint: string;
  fields: { source: string; medium: string; campaign: string; adset: string; ad: string };
  extra: Array<[string, string]>;
}

/**
 * IMPORTANTE: as macros {{...}} (Meta) e {...} (Google) NÃO podem ser
 * percent-encoded no URL final — a plataforma resolve o valor no clique.
 * `encodeUtmValue` codifica o texto do usuário mas preserva as chaves.
 */
function encodeUtmValue(v: string): string {
  return encodeURIComponent(v).replace(/%7B/gi, "{").replace(/%7D/gi, "}");
}

const PRESETS: Preset[] = [
  {
    id: "meta",
    label: "Meta Ads (recomendado)",
    hint: "As macros {{...}} são preenchidas pela Meta no clique — cada lead chega com campanha, conjunto e anúncio.",
    fields: {
      source: "facebook",
      medium: "cpc",
      campaign: "{{campaign.name}}",
      adset: "{{adset.name}}",
      ad: "{{ad.name}}",
    },
    extra: [
      ["campaign_id", "{{campaign.id}}"],
      ["adset_id", "{{adset.id}}"],
      ["ad_id", "{{ad.id}}"],
      ["placement", "{{placement}}"],
    ],
  },
  {
    id: "google",
    label: "Google Ads",
    hint: "ValueTrack do Google preenche {campaignname}, {keyword} e {creative} no clique.",
    fields: {
      source: "google",
      medium: "cpc",
      campaign: "{campaignname}",
      adset: "",
      ad: "{creative}",
    },
    extra: [["utm_id", "{campaignid}"]],
  },
  {
    id: "tiktok",
    label: "TikTok Ads",
    hint: "Preencha os nomes manualmente (iguais aos da campanha). O ttclid do clique é capturado sozinho.",
    fields: {
      source: "tiktok",
      medium: "cpc",
      campaign: "nome_da_campanha",
      adset: "nome_do_conjunto",
      ad: "nome_do_anuncio",
    },
    extra: [],
  },
  {
    id: "manual",
    label: "Manual / outro",
    hint: "Para bio, QR code, e-mail ou qualquer link próprio.",
    fields: { source: "", medium: "", campaign: "", adset: "", ad: "" },
    extra: [],
  },
];

export function LeadFormShareTab({ slug, onSlugChange, publicUrl }: Props) {
  const [presetId, setPresetId] = useState<PresetId>("meta");
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0];
  const [fields, setFields] = useState(preset.fields);

  function applyPreset(id: PresetId) {
    setPresetId(id);
    setFields(PRESETS.find((p) => p.id === id)?.fields ?? PRESETS[0].fields);
  }

  const trackedUrl = useMemo(() => {
    const params: Array<[string, string]> = [];
    if (fields.source.trim()) params.push(["utm_source", fields.source.trim()]);
    if (fields.medium.trim()) params.push(["utm_medium", fields.medium.trim()]);
    if (fields.campaign.trim()) params.push(["utm_campaign", fields.campaign.trim()]);
    if (presetId === "google") {
      // Convenção Google: utm_term é a keyword; o grupo pode ser digitado no campo Conjunto.
      params.push(["utm_term", fields.adset.trim() || "{keyword}"]);
    } else if (fields.adset.trim()) {
      params.push(["utm_term", fields.adset.trim()]);
    }
    if (fields.ad.trim()) params.push(["utm_content", fields.ad.trim()]);
    for (const [k, v] of preset.extra) {
      params.push([k, v]);
    }
    if (params.length === 0) return publicUrl;
    return `${publicUrl}?${params.map(([k, v]) => `${k}=${encodeUtmValue(v)}`).join("&")}`;
  }, [publicUrl, fields, preset, presetId]);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
    } catch {
      toast.error("Não foi possível copiar");
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>Link público</CardTitle>
          <CardDescription>Endereço do formulário + slug personalizável.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>Slug público</Label>
            <div className="flex gap-2">
              <Input
                value={slug}
                onChange={(e) => onSlugChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              />
              <Button variant="outline" onClick={() => copy(publicUrl, "Link copiado")} aria-label="Copiar link público">
                <Copy className="h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={() => window.open(publicUrl, "_blank")} aria-label="Abrir formulário">
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Embed (iframe)</Label>
            <Textarea
              readOnly
              value={`<iframe src="${publicUrl}?embed=1" width="100%" height="700" frameborder="0" style="border-radius:12px"></iframe>`}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4" /> Rastrear campanha e anúncio
          </CardTitle>
          <CardDescription>
            Monte o link do anúncio aqui. Com os parâmetros corretos, cada resposta mostra
            de qual <strong>campanha e anúncio</strong> o lead veio — e o CAPI devolve isso à Meta.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Plataforma</Label>
              <Select value={presetId} onValueChange={(v) => applyPreset(v as PresetId)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground md:pt-7">{preset.hint}</p>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {(
              [
                ["source", "Origem (utm_source)"],
                ["medium", "Mídia (utm_medium)"],
                ["campaign", "Campanha (utm_campaign)"],
                ["adset", "Conjunto (utm_term)"],
                ["ad", "Anúncio (utm_content)"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-2">
                <Label>{label}</Label>
                <Input
                  value={fields[key]}
                  onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
                  placeholder={key === "campaign" ? "{{campaign.name}}" : "…"}
                  className="font-mono text-xs"
                />
              </div>
            ))}
          </div>

          {preset.extra.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {preset.extra.map(([k, v]) => (
                <Badge key={k} variant="outline" className="font-mono text-[10px]">
                  {k}={v}
                </Badge>
              ))}
              <span className="text-[11px] text-muted-foreground">+ IDs incluídos automaticamente</span>
            </div>
          )}

          <div className="space-y-2">
            <Label>Link final do anúncio</Label>
            <div className="rounded border border-border bg-muted p-3 font-mono text-xs break-all">
              {trackedUrl}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => copy(trackedUrl, "Link de anúncio copiado")}>
                <Copy className="h-3.5 w-3.5" /> Copiar link
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.open(trackedUrl, "_blank")}>
                <ExternalLink className="h-3.5 w-3.5" /> Abrir para testar
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Cole este link no campo URL do anúncio. Depois responda pelo link e confira a origem na aba Respostas.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
