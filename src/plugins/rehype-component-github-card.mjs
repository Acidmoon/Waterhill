/// <reference types="mdast" />
import { h } from "hastscript";
import { execSync } from "node:child_process";

const repoCache = new Map();

// 构建时(服务端)抓取仓库数据,把数据直接嵌进页面:
// 访客浏览器无需再请求 api.github.com,卡片在任何网络环境都能即刻渲染。
// 构建失败时返回 null,客户端仍会退回原有的浏览器端 fetch 兜底。
function fetchRepoDataSync(repo) {
	if (repoCache.has(repo)) return repoCache.get(repo);
	let data = null;
	try {
		const token = process.env.GITHUB_TOKEN || "";
		const auth = token ? ` -H "Authorization: Bearer ${token}"` : "";
		const out = execSync(
			`curl -sf --max-time 8${auth} -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${repo}"`,
			{ encoding: "utf8", env: process.env },
		);
		data = JSON.parse(out);
	} catch {
		data = null;
	}
	repoCache.set(repo, data);
	return data;
}

function compactNum(n) {
	return new Intl.NumberFormat("en-us", { notation: "compact", maximumFractionDigits: 1 }).format(n ?? 0).replaceAll(String.fromCharCode(8239), "");
}

/**
 * Creates a GitHub Card component.
 *
 * @param {Object} properties - The properties of the component.
 * @param {string} properties.repo - The GitHub repository in the format "owner/repo".
 * @param {import('mdast').RootContent[]} children - The children elements of the component.
 * @returns {import('mdast').Parent} The created GitHub Card component.
 */
export function GithubCardComponent(properties, children) {
	if (Array.isArray(children) && children.length !== 0)
		return h("div", { class: "hidden" }, [
			'Invalid directive. ("github" directive must be leaf type "::github{repo="owner/repo"}")',
		]);

	if (!properties.repo || !properties.repo.includes("/"))
		return h(
			"div",
			{ class: "hidden" },
			'Invalid repository. ("repo" attributte must be in the format "owner/repo")',
		);

	const repo = properties.repo;
	const cardUuid = `GC${Math.random().toString(36).slice(-6)}`; // Collisions are not important

	const repoData = fetchRepoDataSync(repo);
	const __ok = Boolean(repoData);
	const descText = repoData?.description?.replace(/:[a-zA-Z0-9_]+:/g, "") || "Description not set";
	const langText = repoData?.language || "N/A";
	const starsText = compactNum(repoData?.stargazers_count);
	const forksText = compactNum(repoData?.forks_count ?? repoData?.forks);
	const licText = repoData?.license?.spdx_id || "no-license";

	const nAvatar = h(`div#${cardUuid}-avatar`, { class: "gc-avatar" });
	const nLanguage = h(
		`span#${cardUuid}-language`,
		{ class: "gc-language" },
		langText,
	);

	const nTitle = h("div", { class: "gc-titlebar" }, [
		h("div", { class: "gc-titlebar-left" }, [
			h("div", { class: "gc-owner" }, [
				nAvatar,
				h("div", { class: "gc-user" }, repo.split("/")[0]),
			]),
			h("div", { class: "gc-divider" }, "/"),
			h("div", { class: "gc-repo" }, repo.split("/")[1]),
		]),
		h("div", { class: "github-logo" }),
	]);

	const nDescription = h(
		`div#${cardUuid}-description`,
		{ class: "gc-description" },
		descText,
	);

	const nStars = h(`div#${cardUuid}-stars`, { class: "gc-stars" }, starsText);
	const nForks = h(`div#${cardUuid}-forks`, { class: "gc-forks" }, forksText);
	const nLicense = h(`div#${cardUuid}-license`, { class: "gc-license" }, licText);

	const nScript = h(
		`script#${cardUuid}-script`,
		{ type: "text/javascript", defer: true },
		`
      window.__GC_${cardUuid}_OK = ${__ok};
      if (window.__GC_${cardUuid}_OK === true) {
        const av = document.getElementById('${cardUuid}-avatar');
        if (av && ${repoData?.owner?.avatar_url ? "true" : "false"}) { av.style.backgroundImage = 'url(${repoData.owner.avatar_url})'; av.style.backgroundColor = 'transparent'; }
        console.log("[GITHUB-CARD] Loaded card for ${repo} | ${cardUuid}.")
        return;
      }
      fetch('https://api.github.com/repos/${repo}', { referrerPolicy: "no-referrer" }).then(response => response.json()).then(data => {
        document.getElementById('${cardUuid}-description').innerText = data.description?.replace(/:[a-zA-Z0-9_]+:/g, '') || "Description not set";
        document.getElementById('${cardUuid}-language').innerText = data.language;
        document.getElementById('${cardUuid}-forks').innerText = Intl.NumberFormat('en-us', { notation: "compact", maximumFractionDigits: 1 }).format(data.forks).replaceAll("\u202f", '');
        document.getElementById('${cardUuid}-stars').innerText = Intl.NumberFormat('en-us', { notation: "compact", maximumFractionDigits: 1 }).format(data.stargazers_count).replaceAll("\u202f", '');
        const avatarEl = document.getElementById('${cardUuid}-avatar');
        avatarEl.style.backgroundImage = 'url(' + data.owner.avatar_url + ')';
        avatarEl.style.backgroundColor = 'transparent';
        document.getElementById('${cardUuid}-license').innerText = data.license?.spdx_id || "no-license";
        document.getElementById('${cardUuid}-card').classList.remove("fetch-waiting");
        console.log("[GITHUB-CARD] Loaded card for ${repo} | ${cardUuid}.")
      }).catch(err => {
        const c = document.getElementById('${cardUuid}-card');
        c?.classList.add("fetch-error");
        console.warn("[GITHUB-CARD] (Error) Loading card for ${repo} | ${cardUuid}.")
      })
    `,
	);

	return h(
		`a#${cardUuid}-card`,
		{
			class: __ok ? "card-github no-styling" : "card-github fetch-waiting no-styling",
			href: `https://github.com/${repo}`,
			target: "_blank",
			repo,
		},
		[
			nTitle,
			nDescription,
			h("div", { class: "gc-infobar" }, [nStars, nForks, nLicense, nLanguage]),
			nScript,
		],
	);
}