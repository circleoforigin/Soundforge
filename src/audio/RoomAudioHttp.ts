async function errorMessage(response: Response): Promise<string> {
  try { return (await response.json() as { message?: string }).message ?? `Room audio request failed (${response.status}).`; }
  catch { return `Room audio request failed (${response.status}).`; }
}

export async function requireSuccessfulRoomAudioResponse(responseOrPromise: Response | Promise<Response>): Promise<Response> {
  const response = await responseOrPromise;
  if (!response.ok) throw new Error(await errorMessage(response));
  return response;
}

export { errorMessage as roomAudioErrorMessage };
