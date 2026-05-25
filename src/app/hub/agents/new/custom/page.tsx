import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { CustomBuilder } from "./custom-builder";

export const dynamic = "force-dynamic";

export default async function CustomBuilderPage() {
  const session = await getSession();
  if (!session) redirect("/");
  return <CustomBuilder />;
}
