/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaginationControls, ReportActions } from "./components";

describe("analysis result component interactions", () => {
  afterEach(() => cleanup());

  it("keeps refresh and download actions independent", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const onDownload = vi.fn();

    render(
      <ReportActions
        isRefreshing={false}
        isDownloading={true}
        canDownload={true}
        isRunning={false}
        onRefresh={onRefresh}
        onDownload={onDownload}
      />
    );

    const [refreshButton, downloadButton] = screen.getAllByRole("button");
    expect(refreshButton).toHaveProperty("disabled", false);
    expect(downloadButton).toHaveProperty("disabled", true);

    await user.click(refreshButton);

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("fires pagination callbacks and disables unavailable directions", async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    const onNext = vi.fn();

    render(<PaginationControls total={42} page={2} pageCount={3} onPrev={onPrev} onNext={onNext} />);

    const [previousButton, nextButton] = screen.getAllByRole("button");
    await user.click(previousButton);
    await user.click(nextButton);

    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);

    render(<PaginationControls total={0} page={1} pageCount={0} onPrev={onPrev} onNext={onNext} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.at(-2)).toHaveProperty("disabled", true);
    expect(buttons.at(-1)).toHaveProperty("disabled", true);
  });
});
