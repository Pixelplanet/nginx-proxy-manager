/// <reference types="cypress" />

// POST /api/nginx/regenerate rewrites every enabled host's config from the database and reloads nginx once
describe('Regenerate all host configs', () => {
	// Network aliases of the fullstack container, requests carry this Host header
	const domain = 'website3.example.com';
	const warnDomain = 'website4.example.com';

	let token;
	let hostId;
	let warnHostId;

	const proxyHost = (domainName, extra) => {
		return Object.assign({
			domain_names:            [domainName],
			forward_scheme:          'http',
			forward_host:            'examplesite',
			forward_port:            80,
			access_list_id:          0,
			certificate_id:          0,
			meta:                    {},
			advanced_config:         '',
			locations:               [],
			block_exploits:          false,
			caching_enabled:         false,
			allow_websocket_upgrade: false,
			http2_support:           false,
			hsts_enabled:            false,
			hsts_subdomains:         false,
			ssl_forced:              false
		}, extra || {});
	};

	const request = (host) => {
		return cy.task('exec', { command: `curl --noproxy '*' -s -o /dev/null -w '%{http_code}' -H 'Host: ${host}' http://fullstack/` })
			.then((result) => result.stdout.trim());
	};

	before(() => {
		cy.resetUsers();
		cy.getToken().then((tok) => {
			token = tok;
			cy.task('backendApiPost', {
				token: token,
				path:  '/api/nginx/proxy-hosts',
				data:  proxyHost(domain),
			}).then((data) => {
				hostId = data.id;
			});
			cy.task('backendApiPost', {
				token: token,
				path:  '/api/nginx/proxy-hosts',
				data:  proxyHost(warnDomain, {
					locations: [
						{
							path:           '/ghost',
							forward_scheme: 'http',
							forward_host:   'nonexistent-regenerate-npm-test',
							forward_port:   80,
						},
					],
				}),
			}).then((data) => {
				warnHostId = data.id;
				expect(data.meta.nginx_locations[0]).to.include({ status: 'unresolved' });
			});
		});
	});

	it('Should regenerate all hosts and report locations that do not work', () => {
		cy.task('backendApiPost', {
			token: token,
			path:  '/api/nginx/regenerate',
			data:  {},
		}).then((data) => {
			cy.validateSwaggerSchema('post', 200, '/nginx/regenerate', data);
			expect(data.checked).to.be.at.least(2);
			expect(data.regenerated).to.be.at.least(2);
			expect(data.offline).to.be.an('array');
			expect(data.failed).to.have.length(0);
			expect(data.duration_ms).to.be.a('number');
			expect(data.offline.map((h) => h.id)).not.to.include(hostId);

			const warning = data.warnings.find((w) => w.host_type === 'proxy_host' && w.id === warnHostId);
			expect(warning).to.include({ name: warnDomain });
			expect(warning.message).to.contain('/ghost');
		});

		// Still served after the reload
		cy.waitUntil(() => request(domain).then((status) => status === '200'), {
			timeout:  15000,
			interval: 500,
		});
	});

	it('Should keep the host online and its status fresh', () => {
		cy.task('backendApiGet', {
			token: token,
			path:  `/api/nginx/proxy-hosts/${hostId}`,
		}).then((data) => {
			expect(data.meta).to.have.property('nginx_online', true);
			expect(data.meta).to.have.property('nginx_err', null);
		});
	});

	it('Should only regenerate the requested host types', () => {
		cy.task('backendApiPost', {
			token: token,
			path:  '/api/nginx/regenerate',
			data:  { host_types: ['dead_host'] },
		}).then((data) => {
			cy.validateSwaggerSchema('post', 200, '/nginx/regenerate', data);
			// no 404 hosts in this spec
			expect(data.warnings.map((w) => w.id)).not.to.include(warnHostId);
			const types = [...data.offline, ...data.failed, ...data.warnings].map((h) => h.host_type);
			types.forEach((type) => expect(type).to.equal('dead_host'));
		});

		cy.task('backendApiPost', {
			token:         token,
			path:          '/api/nginx/regenerate',
			data:          { host_types: ['nope'] },
			returnOnError: true,
		}).then((data) => {
			expect(data.error.code).to.equal(400);
		});
	});

	it('Should write an audit log entry', () => {
		cy.task('backendApiGet', {
			token: token,
			path:  '/api/audit-log',
		}).then((data) => {
			cy.validateSwaggerSchema('get', 200, '/audit-log', data);
			const entry = data.find((e) => e.object_type === 'nginx-config' && e.action === 'regenerated');
			expect(entry).to.not.equal(undefined);
			expect(entry.object_id).to.equal(0);
			expect(entry.meta).to.have.property('checked');
		});
	});

	it('Should refuse a second regeneration while one is running', () => {
		// Two requests at once, straight to the API: one runs, the other one gets a 409
		const curl = `curl --noproxy '*' -s -o /dev/null -w '%{http_code}\\n' -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' -d '{}' http://fullstack:81/api/nginx/regenerate`;
		cy.task('exec', {
			command: `${curl} > /tmp/regen-a.txt & ${curl} > /tmp/regen-b.txt & wait ; cat /tmp/regen-a.txt /tmp/regen-b.txt ; rm -f /tmp/regen-a.txt /tmp/regen-b.txt`,
			timeout: 120000,
		}).then((result) => {
			const codes = result.stdout.trim().split('\n').sort();
			expect(codes).to.deep.equal(['200', '409']);
		});
	});

	it('Should be admin only', () => {
		cy.task('backendApiPost', {
			token: token,
			path:  '/api/users',
			data:  {
				name:     'Regenerate User',
				nickname: 'regen',
				email:    'regenerate@example.com',
				roles:    ['user'],
				auth:     { type: 'password', secret: 'changeme' },
			},
		}).then(() => {
			cy.getToken(null, { identity: 'regenerate@example.com', secret: 'changeme' }).then((userToken) => {
				cy.task('backendApiPost', {
					token:         userToken,
					path:          '/api/nginx/regenerate',
					data:          {},
					returnOnError: true,
				}).then((data) => {
					expect(data.error.code).to.equal(403);
				});
			});
		});
	});

	after(() => {
		[hostId, warnHostId].forEach((id) => {
			if (id) {
				cy.task('backendApiDelete', { token: token, path: `/api/nginx/proxy-hosts/${id}` });
			}
		});
	});
});
