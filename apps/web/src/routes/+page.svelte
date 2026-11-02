<script lang="ts">
	import brian from '#lib/assets/brian.png';
</script>

<section>
	<div class="brian">
		<img src={brian} alt="Brian, a white cartoon dog with a red collar" width="636" height="1000" />
		<div class="shadow" aria-hidden="true"></div>
	</div>

	<h1>Brian</h1>
	<p>A second brain for your agents.</p>
	<a href="/login" class="button">Get your Brian</a>
</section>

<style>
	section {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding-top: 2rem;
		text-align: center;
	}

	.brian {
		position: relative;
		margin-bottom: 2rem;
	}

	img {
		position: relative;
		z-index: 1;
		display: block;
		width: auto;
		height: min(48vh, 400px);
		transform-origin: bottom center;
		transition: transform 300ms cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.brian:hover img {
		transform: rotate(-3deg);
	}

	.shadow {
		position: absolute;
		bottom: -0.6rem;
		left: 50%;
		width: 70%;
		height: 1.2rem;
		border-radius: 50%;
		background: rgb(0 0 0 / 0.07);
		transform: translateX(-50%);
	}

	p {
		margin: 0.4rem 0 1.75rem;
		color: var(--muted);
		font-size: 1.2rem;
	}

	@media (prefers-reduced-motion: reduce) {
		img {
			transition: none;
		}
	}
</style>
