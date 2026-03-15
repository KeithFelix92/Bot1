const { Client, GatewayIntentBits, Events, Partials } = require('discord.js')
const express = require('express')

const BOT_TOKEN = process.env.BOT_TOKEN
const GUILD_ID = process.env.GUILD_ID
const AUTO_ROLE_ID = '1480270989634961596'
const PORT = process.env.PORT || 3000

if (!BOT_TOKEN) {
	throw new Error('Missing BOT_TOKEN environment variable')
}

if (!GUILD_ID) {
	throw new Error('Missing GUILD_ID environment variable')
}

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMembers
	],
	partials: [Partials.GuildMember, Partials.User]
})

const app = express()

app.get('/', (req, res) => {
	res.status(200).send('Bot is running')
})

app.listen(PORT, () => {
	console.log(`Health server listening on port ${PORT}`)
})

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function safeWaitFor(conditionFn, options = {}) {
	const timeoutMs = options.timeoutMs ?? 120000
	const intervalMs = options.intervalMs ?? 3000
	const started = Date.now()

	while (Date.now() - started < timeoutMs) {
		try {
			const result = await conditionFn()
			if (result) {
				return result
			}
		} catch (err) {
			console.error('safeWaitFor condition error:', err)
		}

		await sleep(intervalMs)
	}

	return null
}

async function retry(fn, options = {}) {
	const tries = options.tries ?? 8
	const delayMs = options.delayMs ?? 2500
	let lastErr

	for (let attempt = 1; attempt <= tries; attempt += 1) {
		try {
			return await fn(attempt)
		} catch (err) {
			lastErr = err
			console.error(`Retry attempt ${attempt}/${tries} failed:`, err?.message || err)

			if (attempt < tries) {
				await sleep(delayMs)
			}
		}
	}

	throw lastErr
}

async function fetchGuildReliable() {
	return retry(async () => {
		const guild = await client.guilds.fetch(GUILD_ID)
		if (!guild) {
			throw new Error('Guild fetch returned null')
		}
		return guild
	}, {
		tries: 10,
		delayMs: 3000
	})
}

async function fetchRoleReliable(guild) {
	return retry(async () => {
		const role = await guild.roles.fetch(AUTO_ROLE_ID)
		if (!role) {
			throw new Error(`Role ${AUTO_ROLE_ID} not found`)
		}
		return role
	}, {
		tries: 10,
		delayMs: 3000
	})
}

async function addRoleToMemberReliable(member) {
	if (!member || !member.guild) {
		return false
	}

	if (member.guild.id !== GUILD_ID) {
		return false
	}

	if (member.user?.bot) {
		return false
	}

	if (member.roles.cache.has(AUTO_ROLE_ID)) {
		return true
	}

	const guild = member.guild
	const me = guild.members.me ?? await guild.members.fetchMe()
	const targetRole = await fetchRoleReliable(guild)

	if (!me.permissions.has('ManageRoles')) {
		throw new Error('Bot lacks ManageRoles permission')
	}

	if (me.roles.highest.position <= targetRole.position) {
		throw new Error('Bot role is not above the target role in role hierarchy')
	}

	await retry(async () => {
		const freshMember = await guild.members.fetch(member.id)

		if (freshMember.roles.cache.has(AUTO_ROLE_ID)) {
			return true
		}

		await freshMember.roles.add(AUTO_ROLE_ID, 'Auto-role on join')
		return true
	}, {
		tries: 12,
		delayMs: 4000
	})

	console.log(`Assigned role to ${member.user.tag}`)
	return true
}

async function recoverMissedJoins() {
	console.log('Starting recovery scan')

	const guild = await fetchGuildReliable()
	await fetchRoleReliable(guild)

	const me = guild.members.me ?? await guild.members.fetchMe()

	if (!me.permissions.has('ManageRoles')) {
		console.error('Recovery aborted: bot lacks ManageRoles')
		return
	}

	const readyGuild = await safeWaitFor(async () => {
		const fetched = await client.guilds.fetch(GUILD_ID)
		return fetched || null
	}, {
		timeoutMs: 120000,
		intervalMs: 3000
	})

	if (!readyGuild) {
		console.error('Recovery aborted: guild not available in time')
		return
	}

	await retry(async () => {
		await readyGuild.members.fetch()
		return true
	}, {
		tries: 6,
		delayMs: 5000
	})

	const now = Date.now()
	const recoveryWindowMs = 1000 * 60 * 60 * 24 * 3

	let scanned = 0
	let fixed = 0

	for (const member of readyGuild.members.cache.values()) {
		scanned += 1

		if (member.user?.bot) {
			continue
		}

		if (member.roles.cache.has(AUTO_ROLE_ID)) {
			continue
		}

		const joinedTimestamp = member.joinedTimestamp
		if (!joinedTimestamp) {
			continue
		}

		if (now - joinedTimestamp > recoveryWindowMs) {
			continue
		}

		try {
			await addRoleToMemberReliable(member)
			fixed += 1
		} catch (err) {
			console.error(`Recovery failed for ${member.user.tag}:`, err?.message || err)
		}
	}

	console.log(`Recovery scan complete. Scanned=${scanned} Fixed=${fixed}`)
}

client.once(Events.ClientReady, async readyClient => {
	console.log(`Logged in as ${readyClient.user.tag}`)

	try {
		await recoverMissedJoins()
	} catch (err) {
		console.error('Initial recovery failed:', err)
	}
})

client.on(Events.GuildMemberAdd, async member => {
	try {
		await addRoleToMemberReliable(member)
	} catch (err) {
		console.error(`Join handler failed for ${member.user?.tag || member.id}:`, err?.message || err)
	}
})

client.on(Events.ShardResume, async shardId => {
	console.log(`Shard resumed: ${shardId}`)

	try {
		await recoverMissedJoins()
	} catch (err) {
			console.error('Recovery after shard resume failed:', err)
	}
})

client.on(Events.Error, err => {
	console.error('Client error:', err)
})

client.on(Events.Warn, info => {
	console.warn('Client warning:', info)
})

client.login(BOT_TOKEN)