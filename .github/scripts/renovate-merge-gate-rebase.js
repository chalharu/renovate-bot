const REBASE_RETRY_CHECKBOX_PATTERN =
	/^(\s*-\s*\[)\s*([ xX])(\]\s*(?:<!--\s*rebase-check\s*-->)?\s*If you want to rebase\/retry this PR, check this box[^\r\n]*)$/m;

const ensureRebaseRetryRequested = (body) => {
	if (typeof body !== "string") {
		return {
			body,
			changed: false,
			supported: false,
		};
	}

	let supported = false;
	let changed = false;
	const nextBody = body.replace(
		REBASE_RETRY_CHECKBOX_PATTERN,
		(match, prefix, checkedState, suffix) => {
			supported = true;
			if (checkedState.toLowerCase() === "x") {
				return match;
			}

			changed = true;
			return `${prefix}x${suffix}`;
		},
	);

	return {
		body: nextBody,
		changed,
		supported,
	};
};

module.exports = {
	ensureRebaseRetryRequested,
};
