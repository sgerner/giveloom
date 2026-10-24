import adapter from '@sveltejs/adapter-node';
const developmentSockets = process.env.NODE_ENV === 'production' ? [] : ['ws:', 'wss:'];
export default {
	kit: {
		adapter: adapter(),
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'script-src': ['self', 'https://js.stripe.com'],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:', 'https:'],
				'font-src': ['self', 'data:'],
				'connect-src': [
					'self',
					'https://api.stripe.com',
					'https://*.stripe.com',
					...developmentSockets
				],
				'frame-src': ['self', 'https://js.stripe.com', 'https://hooks.stripe.com'],
				'worker-src': ['self'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'object-src': ['none'],
				'frame-ancestors': ['none']
			}
		}
	}
};
