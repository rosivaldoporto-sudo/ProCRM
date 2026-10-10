import { headers } from "next/headers";
import { PublicForm } from "@/components/lead-forms/public-form";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return {
    title: `Formulário — ${slug}`,
    description: "Responda em menos de 1 minuto e agende sua reunião.",
    robots: { index: false, follow: false },
  };
}

export default async function PublicLeadFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Nonce do proxy (x-nonce) para o <Script> do Meta Pixel — sem ele o
  // snippet inline é bloqueado pelo CSP. Página já é force-dynamic, que
  // é o requisito do guia de CSP para nonces.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <PublicForm slug={slug} nonce={nonce} />;
}
