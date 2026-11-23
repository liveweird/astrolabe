import type { QueryClient } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react";
import { expect } from "vitest";

/**
 * The settled state a negative proof waits for before it asserts that something did NOT happen (no second request, no error banner, no row):
 * the client has no more requests in flight than the test says (`inFlight`, 0 unless one read is deliberately held), and the microtasks that
 * deliver the answers to the page have run. It replaces a real-time pause: the assertion that follows is made after the last thing that could
 * have happened, never after a guess in milliseconds. The proof must still fail when the thing appears (the mutation check in 1.26 T3).
 */
export async function requestsAnswered(client: QueryClient, inFlight = 0): Promise<void> {
  await waitFor(() => expect(client.isFetching()).toBe(inFlight));
  await act(async () => {});
}
