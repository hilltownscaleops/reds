import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

function createOfflineBuilder(message) {
	const response = {
		data: null,
		error: new Error(message),
	};

	const builder = {
		select() {
			return builder;
		},
		insert() {
			return builder;
		},
		update() {
			return builder;
		},
		upsert() {
			return builder;
		},
		delete() {
			return builder;
		},
		eq() {
			return builder;
		},
		order() {
			return builder;
		},
		single() {
			return Promise.resolve(response);
		},
		maybeSingle() {
			return Promise.resolve(response);
		},
		then(resolve, reject) {
			return Promise.resolve(response).then(resolve, reject);
		},
		catch(reject) {
			return Promise.resolve(response).catch(reject);
		},
		finally(callback) {
			return Promise.resolve(response).finally(callback);
		},
	};

	return builder;
}

const offlineSupabase = {
	from() {
		return createOfflineBuilder('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to connect Homefoods ERP to Supabase.');
	},
	rpc() {
		return Promise.resolve({
			data: null,
			error: new Error('Supabase is not configured.'),
		});
	},
};

export const supabase = hasSupabaseConfig ? createClient(supabaseUrl, supabaseAnonKey) : offlineSupabase;