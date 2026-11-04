import { useQuery } from "@tanstack/react-query";
import { getUpstreamHealth, isApiError, type UpstreamHealth } from "src/api/backend";

/**
 * Resolves to null when health information is unavailable to this user
 * (403), or the backend doesn't have the endpoint (404). Status columns then
 * just don't show health problems.
 */
const fetchUpstreamHealth = async (): Promise<UpstreamHealth | null> => {
	try {
		return await getUpstreamHealth();
	} catch (err) {
		if (isApiError(err) && (err.status === 403 || err.status === 404)) {
			return null;
		}
		throw err;
	}
};

const useUpstreamHealth = (options = {}) => {
	return useQuery<UpstreamHealth | null, Error>({
		queryKey: ["upstream-health"],
		queryFn: fetchUpstreamHealth,
		refetchOnWindowFocus: false,
		refetchInterval: 30 * 1000,
		staleTime: 29 * 1000,
		retry: 1,
		...options,
	});
};

export { fetchUpstreamHealth, useUpstreamHealth };
