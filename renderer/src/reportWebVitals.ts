import type { ReportHandler } from "web-vitals";

export const __testUtils = {
	loadWebVitals: () => import("web-vitals"),
};

const reportWebVitals = (onPerfEntry?: ReportHandler) => {
	if (onPerfEntry && onPerfEntry instanceof Function) {
		__testUtils
			.loadWebVitals()
			.then(({ getCLS, getFID, getFCP, getLCP, getTTFB }) => {
				getCLS(onPerfEntry);
				getFID(onPerfEntry);
				getFCP(onPerfEntry);
				getLCP(onPerfEntry);
				getTTFB(onPerfEntry);
			});
	}
};

export default reportWebVitals;
