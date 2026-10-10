"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { LeadFormEditor } from "@/components/lead-forms/lead-form-editor";

export default function LeadFormEditPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    if (!params.id) router.push("/lead-forms");
  }, [params.id, router]);
  if (!params.id) return null;
  return <LeadFormEditor formId={params.id} />;
}
