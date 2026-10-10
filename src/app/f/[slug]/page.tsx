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
  return <PublicForm slug={slug} />;
}
