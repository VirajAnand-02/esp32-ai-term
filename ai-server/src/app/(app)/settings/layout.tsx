import { PageHeader } from "@/components/term/primitives";
import { SettingsTabs } from "./settings-tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PageHeader title="settings" subtitle="models, devices, memory and storage" />
      <SettingsTabs />
      <div className="mt-5">{children}</div>
    </>
  );
}
