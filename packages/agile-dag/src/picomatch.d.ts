declare module "picomatch" {
	interface PicomatchOptions {
		dot?: boolean;
		noglobstar?: boolean;
		nodupes?: boolean;
		nocase?: boolean;
		nobracket?: boolean;
		noext?: boolean;
		noplus?: boolean;
		noregex?: boolean;
		nonegate?: boolean;
		noexpand?: boolean;
	}
	function picomatch(pattern: string | readonly string[], options?: PicomatchOptions): (test: string) => boolean;

	namespace picomatch {
		function isMatch(path: string, patterns: string | readonly string[], options?: PicomatchOptions): boolean;
	}

	export = picomatch;
}
