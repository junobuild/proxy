import {isNullish, nonNullish} from "@dfinity/utils";
import * as express from "express";
import {firestore} from "firebase-admin";
import {
  initPendingQuery,
  readCachedResponse,
  readQuery,
  updateQuery,
  writeCacheResponse,
} from "./db.js";
import {waitOneSecond} from "./utils.js";
import DocumentData = firestore.DocumentData;

type RequestParams = {req: express.Request};

export const proxy = async ({
  req,
  res,
  fn,
}: RequestParams & {
  res: express.Response;
  fn: (params: RequestParams) => Promise<DocumentData>;
}) => {
  const key = req.get("idempotency-key");

  if (isNullish(key)) {
    res.status(500).send(
      // eslint-disable-next-line max-len
      "An idempotency key is mandatory to provide same result no matter how many times it's applied.",
    );
    return;
  }

  const query = await readQuery(key);

  if (nonNullish(query)) {
    await pollCachedResponse({key, res});
    return;
  }

  const {success} = await initPendingQuery({key});

  if (!success) {
    await pollCachedResponse({key, res});
    return;
  }

  try {
    const data = await fn({req});

    await Promise.all([
      writeCacheResponse({key, data}),
      updateQuery({key, status: "success"}),
    ]);

    res.json(data);
  } catch (err: Error | unknown) {
    const error =
      err instanceof Error && err.message !== undefined
        ? err.message
        : "An unexpected error was proxying the request.";

    await updateQuery({key, status: "error", error});

    // Note: Since the function does not always return the same error,
    // the smart contract will interpret it as unable to replicate the response.
    res.status(500).send(err);
  }
};

const pollCachedResponse = async ({
  key,
  res,
  attempt = 1,
}: {
  key: string;
  res: express.Response;
  attempt?: number;
}): Promise<void> => {
  const cache = await readCachedResponse(key);

  if (nonNullish(cache)) {
    res.json(cache);
    return;
  }

  const query = await readQuery(key);
  if (nonNullish(query?.error)) {
    res.status(500).send("Proxying the request failed.");
    return;
  }

  if (attempt < 30) {
    await waitOneSecond();
    return await pollCachedResponse({key, res, attempt: attempt + 1});
  }

  res.status(500).send("No cached response found after 30 seconds.");
};
