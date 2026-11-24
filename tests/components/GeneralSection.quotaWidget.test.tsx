import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom";
import { GeneralSection } from "@/components/settings/sections/GeneralSection";
import type { SettingsFormState } from "@/hooks/useSettings";
import { createTestQueryClient } from "../utils/testQueryClient";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const toastErrorMock = vi.fn();
vi.mock("@/lib/toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("@/components/settings/TerminalSettings", () => ({
  TerminalSelect: () => null,
}));

const platform = vi.hoisted(() => ({ linux: false }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isLinux: () => platform.linux,
}));

const baseSettings = {
  showInTray: true,
  minimizeToTrayOnClose: true,
  language: "zh",
} as SettingsFormState;

function renderSection(
  settings: Partial<SettingsFormState> = {},
  options?: { withQueryClient?: boolean },
) {
  const onAutoSave = vi.fn().mockResolvedValue(true);
  const queryClient = options?.withQueryClient
    ? createTestQueryClient()
    : undefined;
  const fullSettings = { ...baseSettings, ...settings };
  if (queryClient) {
    queryClient.setQueryData(["settings"], fullSettings);
  }
  const wrap = (nextSettings: SettingsFormState) => {
    const node = (
      <GeneralSection
        settings={nextSettings}
        onAutoSave={onAutoSave}
        onOpenApps={vi.fn()}
      />
    );
    return queryClient ? (
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    ) : (
      node
    );
  };
  const view = render(wrap(fullSettings));
  return {
    ...view,
    onAutoSave,
    queryClient,
    rerenderSettings: (next: Partial<SettingsFormState>) =>
      view.rerender(wrap({ ...baseSettings, ...next })),
  };
}

describe("GeneralSection desktop usage widget toggle", () => {
  beforeEach(() => {
    platform.linux = false;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    toastErrorMock.mockReset();
  });

  it("renders unchecked by default and invokes quota_widget_set_enabled when turned on", async () => {
    const { onAutoSave, queryClient } = renderSection(
      {},
      { withQueryClient: true },
    );
    const invalidateSpy = vi.spyOn(queryClient!, "invalidateQueries");
    const toggle = screen.getByRole("switch", {
      name: "settings.general.quotaWidget",
    });

    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("quota_widget_set_enabled", {
        enabled: true,
      }),
    );
    expect(onAutoSave).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        queryClient!.getQueryData<SettingsFormState>(["settings"])
          ?.enableQuotaWidget,
      ).toBe(true),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["settings"] });
  });

  it("renders checked when enableQuotaWidget is true and turns off via quota_widget_set_enabled", async () => {
    const { onAutoSave } = renderSection({ enableQuotaWidget: true });
    const toggle = screen.getByRole("switch", {
      name: "settings.general.quotaWidget",
    });

    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "false");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("quota_widget_set_enabled", {
        enabled: false,
      }),
    );
    expect(onAutoSave).not.toHaveBeenCalled();
  });

  it("reverts state and shows an error toast if quota_widget_set_enabled fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    invokeMock.mockRejectedValueOnce(new Error("window creation failed"));

    renderSection({ enableQuotaWidget: false });
    const toggle = screen.getByRole("switch", {
      name: "settings.general.quotaWidget",
    });

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "false"),
    );
    expect(toastErrorMock).toHaveBeenCalledWith("settings.saveFailedGeneric");
    consoleErrorSpy.mockRestore();
  });

  it("syncs when settings.enableQuotaWidget updates externally and stays visible on Linux", () => {
    platform.linux = true;
    const { rerenderSettings } = renderSection({ enableQuotaWidget: false });
    const toggle = screen.getByRole("switch", {
      name: "settings.general.quotaWidget",
    });

    expect(toggle).toHaveAttribute("aria-checked", "false");

    rerenderSettings({ enableQuotaWidget: true });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});
