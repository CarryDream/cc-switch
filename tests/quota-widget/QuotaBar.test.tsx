import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuotaBar, quotaPercent, quotaStatus } from "@/quota-widget/QuotaBar";

// 同一个槽的几何由 widget.css 统一定义，不能再为单档和双档选择不同容器。
describe("QuotaBar", () => {
  it("keeps the weekly marker visible above a full five-hour bar", () => {
    const { container } = render(
      <QuotaBar left={100} label="5h" weekly={{ left: 30, label: "7d" }} />,
    );
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAccessibleName("5h: 100% · 7d: 30%");
    expect(meter).toHaveAttribute("aria-valuenow", "30");
    const marker = container.querySelector(".qw-week-marker")!;
    expect(marker).toHaveStyle("--week-position: 30%");
    expect(meter.lastElementChild).toBe(marker);
    expect(container.querySelectorAll(".qw-bar-fill")).toHaveLength(1);
  });

  it("shows a depleted week as danger, not as a full available quota", () => {
    const { container } = render(
      <QuotaBar left={100} label="5h" weekly={{ left: 0, label: "7d" }} />,
    );
    expect(screen.getByRole("meter")).toHaveAttribute("data-status", "danger");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
    expect(container.querySelector(".qw-week-marker")).toHaveStyle(
      "--week-position: 0%",
    );
    expect(container.querySelector(".qw-week-marker")).toHaveAttribute(
      "data-status",
      "danger",
    );
  });

  it("renders exact zero as an empty fill", () => {
    const { container } = render(<QuotaBar left={0} label="5h" />);
    expect(container.querySelector(".qw-bar-fill")).toHaveStyle(
      "transform: scaleX(0)",
    );
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "0");
  });

  it("uses the same track for single and dual quotas", () => {
    const { container, rerender } = render(<QuotaBar left={45} label="5h" />);
    expect(screen.getByRole("meter")).toHaveClass("qw-bar-track");
    expect(container.querySelector(".qw-week-marker")).toBeNull();
    rerender(
      <QuotaBar left={45} label="5h" weekly={{ left: 45, label: "7d" }} />,
    );
    expect(screen.getByRole("meter")).toHaveClass("qw-bar-track");
    expect(container.querySelectorAll(".qw-bar-track")).toHaveLength(1);
    expect(container.querySelector(".qw-week-marker")).not.toBeNull();
  });

  it("assigns severity independently and clamps invalid inputs", () => {
    expect(quotaStatus(0)).toBe("danger");
    expect(quotaStatus(19)).toBe("warn");
    expect(quotaStatus(20)).toBe("normal");
    expect(quotaPercent(-3)).toBe(0);
    expect(quotaPercent(120)).toBe(100);
    expect(quotaPercent(Number.NaN)).toBe(0);
    expect(quotaPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
